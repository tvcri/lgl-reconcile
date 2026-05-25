import fs from 'fs';

const LGL_BASE = 'https://api.littlegreenlight.com/api/v1';
const LGL_PAGE_LIMIT = 2500;
const LGL_CACHE_DIR = 'lgl-cache';

let CACHE_ENABLED = true;

export function setUseCache(enabled) {
  CACHE_ENABLED = enabled;
}

function authHeader() {
  const key = process.env.LGL_API_KEY;
  if (!key) throw new Error('LGL_API_KEY environment variable is not set');
  return 'Basic ' + Buffer.from(`${key}:`).toString('base64');
}

/**
 * Generate a cache key from a path and parameters.
 */
function getCacheKey(path, params) {
  const paramsStr = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const key = `${path}?${paramsStr}`.replace(/[^a-zA-Z0-9-_.]/g, '_');
  return key;
}

/**
 * Load cached API response if it exists.
 */
function getCachedResponse(path, params) {
  const key = getCacheKey(path, params);
  const filePath = `${LGL_CACHE_DIR}/${key}.json`;

  if (fs.existsSync(filePath)) {
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data);
    } catch (e) {
      console.warn(`Failed to read cache file ${filePath}: ${e.message}`);
    }
  }

  return null;
}

/**
 * Save API response to cache.
 */
function cacheResponse(path, params, data) {
  if (!fs.existsSync(LGL_CACHE_DIR)) {
    fs.mkdirSync(LGL_CACHE_DIR, { recursive: true });
  }

  const key = getCacheKey(path, params);
  const filePath = `${LGL_CACHE_DIR}/${key}.json`;

  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn(`Failed to write cache file ${filePath}: ${e.message}`);
  }
}

async function lglGet(path, params = {}) {
  // Check cache first if enabled
  if (CACHE_ENABLED) {
    const cached = getCachedResponse(path, params);
    if (cached) {
      console.log(`[LGL GET] ${path} (from cache)`);
      return cached;
    }
  }

  const url = new URL(`${LGL_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  console.log(`[LGL GET] ${url.toString()}`);
  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': authHeader(),
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`LGL API error ${res.status} on GET ${path}: ${await res.text()}`);
  }
  const json = await res.json();

  // Cache the response
  if (CACHE_ENABLED) {
    cacheResponse(path, params, json);
  }

  return json;
}

async function lglPatch(path, body) {
  const url = `${LGL_BASE}${path}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`LGL API error ${res.status} on PATCH ${path}: ${await res.text()}`);
  }
  return res.json();
}

/**
 * Fetch all constituents for the account.
 * Handles pagination defensively but in practice pulls everything in one request.
 * @returns {Promise<Array>} Full array of constituent list records
 */
export async function fetchAllConstituents() {
  const constituents = [];
  let offset = 0;

  while (true) {
    const data = await lglGet('/constituents', { limit: LGL_PAGE_LIMIT, offset });
    constituents.push(...data.items);
    if (constituents.length >= data.total_items) break;
    offset += data.items_count;
  }

  return constituents;
}

/**
 * Fetch full detail for a single constituent, including street_addresses,
 * email_addresses, phone_numbers, and all other sub-resources.
 * @param {number} id - LGL constituent ID
 * @returns {Promise<Object>} Full constituent detail record
 */
export async function fetchConstituentDetail(id) {
  return lglGet(`/constituents/${id}`);
}

/**
 * Fetch full details for an array of constituent IDs with bounded concurrency.
 * @param {number[]} ids - Array of LGL constituent IDs
 * @param {number} concurrency - Max simultaneous requests (default 10)
 * @returns {Promise<Object[]>} Array of full constituent detail records
 */
export async function fetchConstituentDetails(ids, concurrency = 10) {
  const results = [];
  for (let i = 0; i < ids.length; i += concurrency) {
    const batch = ids.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(fetchConstituentDetail));
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      } else {
        console.error('Failed to fetch constituent detail:', outcome.reason);
      }
    }
  }
  return results;
}

/**
 * Update a constituent record. Used in the reconcile pass.
 * @param {number} id - LGL constituent ID
 * @param {Object} body - Partial constituent update per LGL PATCH schema
 * @returns {Promise<Object>} Updated constituent record
 */
export async function patchConstituent(id, body) {
  return lglPatch(`/constituents/${id}`, body);
}

/**
 * Fetch all groups for the account.
 * Handles pagination defensively.
 * @returns {Promise<Array>} Full array of group records
 */
export async function fetchAllGroups() {
  const groups = [];
  let offset = 0;

  while (true) {
    const data = await lglGet('/groups', { limit: LGL_PAGE_LIMIT, offset });
    groups.push(...data.items);
    if (groups.length >= data.total_items) break;
    offset += data.items_count;
  }

  return groups;
}

/**
 * Search constituents with advanced filtering via the LGL search API.
 * @param {Object} criteria - Search criteria object
 * @param {string} [criteria.name] - Constituent name search
 * @param {string} [criteria.email] - Email address (eaddr)
 * @param {string} [criteria.phone] - Phone number
 * @param {string} [criteria.city] - City
 * @param {string} [criteria.state] - State
 * @param {string} [criteria.postalCode] - Postal code
 * @param {string} [criteria.externalId] - External ID
 * @param {0|1} [criteria.constituteType] - 0=Individual, 1=Organization
 * @param {0|1} [criteria.membershipStatus] - 0=inactive, 1=active
 * @param {string} [criteria.membershipLevels] - Comma-separated membership level IDs
 * @param {string} [criteria.updatedFrom] - ISO 8601 date (YYYY-MM-DD)
 * @param {string} [criteria.updatedTo] - ISO 8601 date (YYYY-MM-DD)
 * @param {string} [criteria.customAttr] - Custom attribute filter "key|operator|value"
 * @param {string} [criteria.customAttrInt] - Custom integer filter "key|operator|number[|number2]"
 * @param {string} [criteria.keyword] - Category keyword ID
 * @param {string} [criteria.groups] - Comma-separated group IDs
 * @param {string} [criteria.expand] - Comma-separated expand fields: class_affiliations, relationships, street_addresses, phone_numbers, email_addresses, web_addresses, categories, groups, memberships, custom_attrs
 * @param {string} [criteria.sort] - Sort field (name, external_id, lgl_id, date_created, date_updated, membership_level, membership_end_date_from); append ! to reverse
 * @param {number} [criteria.limit] - Results per page (default 25)
 * @param {number} [criteria.offset] - Pagination offset (default 0)
 * @returns {Promise<Object>} Search results with items array and pagination info
 */
export async function searchConstituents(criteria = {}) {
  const queryParts = [];

  if (criteria.name) queryParts.push(`name=${encodeURIComponent(criteria.name)}`);
  if (criteria.email) queryParts.push(`eaddr=${encodeURIComponent(criteria.email)}`);
  if (criteria.phone) queryParts.push(`phone_number=${encodeURIComponent(criteria.phone)}`);
  if (criteria.city) queryParts.push(`city=${encodeURIComponent(criteria.city)}`);
  if (criteria.state) queryParts.push(`state=${encodeURIComponent(criteria.state)}`);
  if (criteria.postalCode) queryParts.push(`postal_code=${encodeURIComponent(criteria.postalCode)}`);
  if (criteria.externalId) queryParts.push(`external_id=${encodeURIComponent(criteria.externalId)}`);
  if (criteria.constituteType !== undefined) queryParts.push(`constituent_type=${criteria.constituteType}`);
  if (criteria.membershipStatus !== undefined) queryParts.push(`membership_status=${criteria.membershipStatus}`);
  if (criteria.membershipLevels) queryParts.push(`membership_level=${encodeURIComponent(criteria.membershipLevels)}`);
  if (criteria.updatedFrom) queryParts.push(`updated_from=${criteria.updatedFrom}`);
  if (criteria.updatedTo) queryParts.push(`updated_to=${criteria.updatedTo}`);
  if (criteria.customAttr) queryParts.push(`custom_attr=${encodeURIComponent(criteria.customAttr)}`);
  if (criteria.customAttrInt) queryParts.push(`custom_attr_int=${encodeURIComponent(criteria.customAttrInt)}`);
  if (criteria.keyword) queryParts.push(`keyword=${criteria.keyword}`);
  if (criteria.groups) queryParts.push(`groups=${encodeURIComponent(criteria.groups)}`);

  const params = {};
  if (queryParts.length > 0) {
    params['q[]'] = queryParts.join(';');
  }
  if (criteria.expand) params['expand'] = criteria.expand;
  if (criteria.sort) params['sort'] = criteria.sort;
  if (criteria.limit !== undefined) params['limit'] = criteria.limit;
  if (criteria.offset !== undefined) params['offset'] = criteria.offset;

  return lglGet('/constituents/search', params);
}
