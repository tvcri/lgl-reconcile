const LGL_BASE = 'https://api.littlegreenlight.com/api/v1';
const LGL_PAGE_LIMIT = 2500;

function authHeader() {
  const key = process.env.LGL_API_KEY;
  if (!key) throw new Error('LGL_API_KEY environment variable is not set');
  return 'Basic ' + Buffer.from(`${key}:`).toString('base64');
}

async function lglGet(path, params = {}) {
  const url = new URL(`${LGL_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': authHeader(),
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`LGL API error ${res.status} on GET ${path}: ${await res.text()}`);
  }
  return res.json();
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
