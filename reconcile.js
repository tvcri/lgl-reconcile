import dotenv from 'dotenv';
dotenv.config();

import Anthropic from '@anthropic-ai/sdk';
import { searchConstituents, fetchConstituentDetails, patchConstituent, fetchAllGroups, setUseCache } from './lgl.js';
import { parseDumpChain } from '../ce-sheets-sync/lib/dump-chain-processor.js';
import fs from 'fs';
import { google } from 'googleapis';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Parse CLI flags
const args = process.argv.slice(2);
const flags = {
  report: args.includes('--report'),
  reconcile: args.includes('--reconcile'),
  dryRun: args.includes('--dry-run'),
  noClaudeAPI: args.includes('--no-claude-api'),
  debug: args.includes('--debug'),
  noCache: args.includes('--no-cache'),
};

if (!flags.report && !flags.reconcile) {
  console.error('Usage: node reconcile.js (--report | --reconcile) [--dry-run] [--no-claude-api] [--no-cache] [--debug]');
  process.exit(1);
}

// Configure caching
if (flags.noCache) {
  console.log('Cache disabled (--no-cache)\n');
  setUseCache(false);
} else {
  console.log('Using cached API responses (use --no-cache to disable)\n');
}

/**
 * Normalize an address string for comparison.
 * Lowercase, expand common abbreviations, trim whitespace.
 */
function normalizeAddress(street) {
  if (!street) return '';
  return street
    .toLowerCase()
    .replace(/\bst\b/g, 'street')
    .replace(/\bave\b/g, 'avenue')
    .replace(/\bdr\b/g, 'drive')
    .replace(/\bln\b/g, 'lane')
    .replace(/\brd\b/g, 'road')
    .replace(/\bapt\b/g, 'apartment')
    .replace(/\b#\b/g, 'number')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract zip5 (first 5 digits) from a postal code.
 */
function getZip5(zip) {
  return zip ? zip.replace(/\D/g, '').slice(0, 5) : '';
}

/**
 * Pre-filter address pairs into exact, different, or ambiguous.
 */
function preFilterAddressPairs(pairs) {
  const exact = [];
  const different = [];
  const ambiguous = [];

  for (const pair of pairs) {
    const ceNorm = normalizeAddress(pair.ceStreet);
    const lglNorm = normalizeAddress(pair.lglStreet);
    const ceZip5 = getZip5(pair.ceZip);
    const lglZip5 = getZip5(pair.lglZip);

    if (ceNorm === lglNorm && ceZip5 === lglZip5) {
      exact.push(pair);
    } else if (ceZip5 && lglZip5 && ceZip5 !== lglZip5) {
      different.push(pair);
    } else {
      ambiguous.push(pair);
    }
  }

  return { exact, different, ambiguous };
}

/**
 * Load all cached Claude verdicts by constituent_id.
 */
function loadAllCachedVerdicts() {
  const filePath = 'lgl-cache/claude-verdicts.json';

  if (fs.existsSync(filePath)) {
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data);
    } catch (e) {
      console.warn(`Failed to read verdicts cache: ${e.message}`);
    }
  }

  return {};
}

/**
 * Save all Claude verdicts to cache.
 */
function saveAllCachedVerdicts(allVerdicts) {
  const filePath = 'lgl-cache/claude-verdicts.json';

  try {
    if (!fs.existsSync('lgl-cache')) {
      fs.mkdirSync('lgl-cache', { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(allVerdicts, null, 2));
  } catch (e) {
    console.warn(`Failed to write verdicts cache: ${e.message}`);
  }
}

/**
 * Send ambiguous address pairs to Claude for evaluation in batches.
 * Skipped if --no-claude-api flag is set.
 * Uses persistent cache of verdicts by constituent_id.
 */
async function evaluateAmbiguousAddresses(ambiguous) {
  const batchSize = 10;
  const verdicts = {};

  if (flags.noClaudeAPI) {
    console.log(`[SKIPPED] Claude API disabled (--no-claude-api). ${ambiguous.length} ambiguous addresses will be marked for review.\n`);
    return verdicts;
  }

  // Load all cached verdicts
  const allCachedVerdicts = loadAllCachedVerdicts();

  // Split into cached vs new
  const needsEvaluation = [];
  const cachedCount = 0;

  for (const pair of ambiguous) {
    if (allCachedVerdicts[pair.constituentId]) {
      verdicts[pair.constituentId] = allCachedVerdicts[pair.constituentId];
    } else {
      needsEvaluation.push(pair);
    }
  }

  if (needsEvaluation.length === 0) {
    console.log(`[CACHE] All ${ambiguous.length} verdicts loaded from cache\n`);
    return verdicts;
  }

  console.log(`[CACHE] ${ambiguous.length - needsEvaluation.length} verdicts from cache, evaluating ${needsEvaluation.length} new addresses...\n`);

  const totalBatches = Math.ceil(needsEvaluation.length / batchSize);

  for (let i = 0; i < needsEvaluation.length; i += batchSize) {
    const batchNum = Math.floor(i / batchSize) + 1;
    const batch = needsEvaluation.slice(i, i + batchSize);
    const pairDescriptions = batch.map(p => ({
      constituent_id: p.constituentId,
      ce_address: `${p.ceStreet}, ${p.ceCity}, ${p.ceState} ${p.ceZip}`,
      lgl_address: `${p.lglStreet}, ${p.lglCity}, ${p.lglState} ${p.lglZip}`,
    }));

    const prompt = `You are evaluating address pairs to determine if they represent the same location. For each pair, respond with:
- "exact": street and zip match after normalization
- "likely_same": different formatting/abbreviation but clearly the same address
- "different": clearly different locations

Address pairs to evaluate:
${JSON.stringify(pairDescriptions, null, 2)}

Respond with valid JSON array where each element has: constituent_id, verdict ("exact" | "likely_same" | "different"), confidence (0.0-1.0), reason, recommended_action ("auto_update" | "confirm" | "review")`;

    process.stdout.write(`  Batch ${batchNum}/${totalBatches}... `);
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });
    console.log('done');

    try {
      const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const batchVerdicts = JSON.parse(jsonMatch[0]);
        for (const v of batchVerdicts) {
          verdicts[v.constituent_id] = v;
          allCachedVerdicts[v.constituent_id] = v;
        }
      }
    } catch (e) {
      console.error('Failed to parse Claude response:', e.message);
    }
  }

  console.log('');

  // Save updated cache
  saveAllCachedVerdicts(allCachedVerdicts);

  return verdicts;
}

/**
 * Match a CE record to an LGL constituent from a pre-loaded array.
 * Strategy: primary match on email, secondary on name.
 */
function matchCERecordToLGLArray(ceRecord, lglConstituents) {
  const { firstName, lastName, email } = ceRecord;

  // Try email first
  if (email) {
    if (flags.debug) {
      console.log(`\n[DEBUG] Searching for email: "${email}" (${email.toLowerCase()})`);
    }

    const emailMatches = lglConstituents.filter(c => {
      if (!c.email_addresses) return false;
      return c.email_addresses.some(e => e.address && e.address.toLowerCase() === email.toLowerCase());
    });

    if (flags.debug && emailMatches.length > 0) {
      console.log(`[DEBUG] Found ${emailMatches.length} email match(es)`);
      emailMatches.forEach(m => {
        console.log(`  - ${m.first_name} ${m.last_name} (LGL ID: ${m.id}), emails: ${m.email_addresses?.map(e => e.address).join(', ') || 'none'}`);
      });
    }

    if (emailMatches.length === 1) {
      return { matched: true, constituentId: emailMatches[0].id, lglRecord: emailMatches[0], matchType: 'email_exact' };
    }

    // If multiple email matches, try to break tie with name
    if (emailMatches.length > 1 && firstName && lastName) {
      if (flags.debug) {
        console.log(`[DEBUG] Multiple email matches, trying to break tie with name: "${firstName} ${lastName}"`);
      }

      const nameMatched = emailMatches.find(c => {
        const fullName = `${c.first_name || ''} ${c.last_name || ''}`.toLowerCase();
        const searchName = `${firstName} ${lastName}`.toLowerCase();
        return fullName === searchName;
      });

      if (nameMatched) {
        if (flags.debug) {
          console.log(`[DEBUG] Tie-breaker: Found exact name match in email matches`);
        }
        return { matched: true, constituentId: nameMatched.id, lglRecord: nameMatched, matchType: 'email_with_name_tiebreak' };
      }

      if (flags.debug) {
        console.log(`[DEBUG] Tie-breaker: No exact name match in email matches, falling back to name search`);
      }
      // Fall through to name search instead of returning unmatched
    } else if (emailMatches.length > 1) {
      // Multiple email matches but no name to break tie, fall through to name search
      if (flags.debug) {
        console.log(`[DEBUG] Multiple email matches with no name provided, falling back to name search`);
      }
    }

    // If we have a single email match (not multiple), return it
    if (emailMatches.length === 1) {
      return { matched: true, constituentId: emailMatches[0].id, lglRecord: emailMatches[0], matchType: 'email_exact' };
    }
  }

  // Fall back to name search: require exact match on BOTH first AND last name
  if (firstName && lastName) {
    const nameMatches = lglConstituents.filter(c => {
      const cFirstName = (c.first_name || '').trim().toLowerCase();
      const cLastName = (c.last_name || '').trim().toLowerCase();
      const searchFirstName = firstName.trim().toLowerCase();
      const searchLastName = lastName.trim().toLowerCase();

      // Only match if both first and last names are non-empty and match exactly
      if (!cFirstName || !cLastName || !searchFirstName || !searchLastName) {
        return false;
      }

      return cFirstName === searchFirstName && cLastName === searchLastName;
    });

    if (nameMatches.length === 1) {
      return { matched: true, constituentId: nameMatches[0].id, lglRecord: nameMatches[0], matchType: 'name_exact' };
    }
    if (nameMatches.length > 1) {
      return { matched: false, reason: 'multiple_name_matches', candidates: nameMatches };
    }
  }

  return { matched: false, reason: 'no_match' };
}

/**
 * Extract preferred non-current street address from LGL constituent.
 */
function getPreferredAddress(constituent) {
  if (!constituent.street_addresses || constituent.street_addresses.length === 0) {
    return null;
  }

  // Find preferred non-seasonal current address
  const preferred = constituent.street_addresses.find(
    addr => addr.is_preferred && !addr.not_current && !addr.seasonal_from && !addr.seasonal_to
  );

  return preferred || constituent.street_addresses[0];
}

/**
 * Compare CE and LGL addresses for a matched pair.
 */
function compareAddresses(ceRecord, lglRecord) {
  const ceAddr = {
    street: ceRecord.street || '',
    city: ceRecord.city || '',
    state: ceRecord.state || '',
    zip: ceRecord.zip || '',
  };

  const lglAddr = getPreferredAddress(lglRecord);
  if (!lglAddr) {
    return {
      status: 'missing_lgl_address',
      ceAddress: ceAddr,
      lglAddress: null,
    };
  }

  return {
    status: 'needs_comparison',
    ceAddress: ceAddr,
    lglAddress: {
      street: lglAddr.street || '',
      city: lglAddr.city || '',
      state: lglAddr.state || '',
      zip: lglAddr.postal_code || '',
    },
  };
}

/**
 * Check if a constituent is in a specific group.
 */
function isConstituentInGroup(constituent, groupName) {
  if (!constituent.groups || constituent.groups.length === 0) {
    return false;
  }
  return constituent.groups.some(g => g.group_name === groupName);
}

/**
 * Main reconciliation workflow.
 */
async function reconcile(ceRecords, lglConstituents) {
  console.log(`Starting reconciliation for ${ceRecords.length} CE records against ${lglConstituents.length} LGL constituents...\n`);

  const conflicts = {
    autoReconcilable: [],
    needsConfirmation: [],
    needsReview: [],
    unmatched: [],
    groupMismatch: [],
  };

  const addressPairs = [];

  // Phase 1: Match CE records to LGL constituents (from pre-loaded array)
  for (const ceRecord of ceRecords) {
    const match = matchCERecordToLGLArray(ceRecord, lglConstituents);

    if (!match.matched) {
      conflicts.unmatched.push({
        ceRecord,
        reason: match.reason,
        candidates: match.candidates || [],
      });
      continue;
    }

    // Check if matched constituent has the correct group assignment
    const expectedGroup = ceRecord._ceType === 'member' ? 'Member' : 'Volunteer';
    const hasCorrectGroup = isConstituentInGroup(match.lglRecord, expectedGroup);

    if (!hasCorrectGroup) {
      const actualGroups = (match.lglRecord.groups || []).map(g => g.group_name);
      conflicts.groupMismatch.push({
        ceRecord,
        lglRecord: match.lglRecord,
        constituentId: match.constituentId,
        expectedGroup,
        actualGroups,
      });
      continue;
    }

    const comparison = compareAddresses(ceRecord, match.lglRecord);

    if (comparison.status === 'missing_lgl_address') {
      conflicts.needsReview.push({
        ceRecord,
        lglRecord: match.lglRecord,
        issue: 'LGL constituent has no address',
      });
      continue;
    }

    // Collect for batch address evaluation
    addressPairs.push({
      ceRecord,
      lglRecord: match.lglRecord,
      constituentId: match.constituentId,
      matchType: match.matchType,
      ceStreet: comparison.ceAddress.street,
      ceCity: comparison.ceAddress.city,
      ceState: comparison.ceAddress.state,
      ceZip: comparison.ceAddress.zip,
      lglStreet: comparison.lglAddress.street,
      lglCity: comparison.lglAddress.city,
      lglState: comparison.lglAddress.state,
      lglZip: comparison.lglAddress.zip,
    });
  }

  // Phase 2: Pre-filter and batch-evaluate addresses
  const { exact, different, ambiguous } = preFilterAddressPairs(addressPairs);

  console.log(`Address comparison: ${exact.length} exact, ${different.length} different, ${ambiguous.length} ambiguous\n`);

  // All exact matches are auto-reconcilable
  conflicts.autoReconcilable.push(
    ...exact.map(p => ({
      ceRecord: p.ceRecord,
      lglRecord: p.lglRecord,
      constituentId: p.constituentId,
      verdict: 'exact',
      action: 'auto_update',
    }))
  );

  // All different are flagged for review
  conflicts.needsReview.push(
    ...different.map(p => ({
      ceRecord: p.ceRecord,
      lglRecord: p.lglRecord,
      constituentId: p.constituentId,
      issue: 'address_mismatch',
      ceAddress: `${p.ceStreet}, ${p.ceCity}, ${p.ceState} ${p.ceZip}`,
      lglAddress: `${p.lglStreet}, ${p.lglCity}, ${p.lglState} ${p.lglZip}`,
    }))
  );

  // Ambiguous go to Claude (unless disabled)
  if (ambiguous.length > 0) {
    if (!flags.noClaudeAPI) {
      console.log(`Sending ${ambiguous.length} ambiguous addresses to Claude for evaluation...\n`);
    }
    const verdicts = await evaluateAmbiguousAddresses(ambiguous);

    for (const pair of ambiguous) {
      const verdict = verdicts[pair.constituentId];

      // If Claude API was skipped, all ambiguous go to needs review
      if (flags.noClaudeAPI) {
        conflicts.needsReview.push({
          ceRecord: pair.ceRecord,
          lglRecord: pair.lglRecord,
          constituentId: pair.constituentId,
          issue: 'ambiguous_address_skipped_claude',
          ceAddress: `${pair.ceStreet}, ${pair.ceCity}, ${pair.ceState} ${pair.ceZip}`,
          lglAddress: `${pair.lglStreet}, ${pair.lglCity}, ${pair.lglState} ${pair.lglZip}`,
        });
        continue;
      }

      if (!verdict) continue;

      if (verdict.recommended_action === 'auto_update' && verdict.confidence >= 0.8) {
        conflicts.autoReconcilable.push({
          ceRecord: pair.ceRecord,
          lglRecord: pair.lglRecord,
          constituentId: pair.constituentId,
          verdict: verdict.verdict,
          confidence: verdict.confidence,
          reason: verdict.reason,
          action: 'auto_update',
        });
      } else if (verdict.recommended_action === 'confirm') {
        conflicts.needsConfirmation.push({
          ceRecord: pair.ceRecord,
          lglRecord: pair.lglRecord,
          constituentId: pair.constituentId,
          verdict: verdict.verdict,
          confidence: verdict.confidence,
          reason: verdict.reason,
          ceAddress: `${pair.ceStreet}, ${pair.ceCity}, ${pair.ceState} ${pair.ceZip}`,
          lglAddress: `${pair.lglStreet}, ${pair.lglCity}, ${pair.lglState} ${pair.lglZip}`,
        });
      } else {
        conflicts.needsReview.push({
          ceRecord: pair.ceRecord,
          lglRecord: pair.lglRecord,
          constituentId: pair.constituentId,
          verdict: verdict.verdict,
          reason: verdict.reason,
          ceAddress: `${pair.ceStreet}, ${pair.ceCity}, ${pair.ceState} ${pair.ceZip}`,
          lglAddress: `${pair.lglStreet}, ${pair.lglCity}, ${pair.lglState} ${pair.lglZip}`,
        });
      }
    }
  }

  return conflicts;
}

/**
 * Generate and print the conflict report.
 */
function generateReport(conflicts) {
  console.log('\n========== RECONCILIATION REPORT ==========\n');

  console.log(`AUTO-RECONCILABLE (${conflicts.autoReconcilable.length}):`);
  for (const item of conflicts.autoReconcilable) {
    console.log(
      `  ✓ ${item.ceRecord.firstName} ${item.ceRecord.lastName} (${item.ceRecord.email}) → LGL #${item.constituentId}`
    );
  }

  console.log(`\nNEEDS CONFIRMATION (${conflicts.needsConfirmation.length}):`);
  for (const item of conflicts.needsConfirmation) {
    console.log(
      `  ? ${item.ceRecord.firstName} ${item.ceRecord.lastName} (${item.ceRecord.email}) → LGL #${item.constituentId}`
    );
    console.log(`    CE:  ${item.ceAddress}`);
    console.log(`    LGL: ${item.lglAddress}`);
    console.log(`    Confidence: ${item.confidence}`);
  }

  console.log(`\nNEEDS REVIEW (${conflicts.needsReview.length}):`);
  for (const item of conflicts.needsReview) {
    console.log(`  ✗ ${item.ceRecord.firstName} ${item.ceRecord.lastName} (${item.ceRecord.email})`);
    console.log(`    Issue: ${item.issue || item.verdict}`);
    if (item.ceAddress && item.lglAddress) {
      console.log(`    CE:  ${item.ceAddress}`);
      console.log(`    LGL: ${item.lglAddress}`);
    }
  }

  console.log(`\nGROUP MISMATCH (${conflicts.groupMismatch.length}):`);
  for (const item of conflicts.groupMismatch) {
    console.log(`  ⚠ ${item.ceRecord.firstName} ${item.ceRecord.lastName} (${item.ceRecord.email}) → LGL #${item.constituentId}`);
    console.log(`    Expected group: "${item.expectedGroup}"`);
    console.log(`    Actual groups: ${item.actualGroups.length === 0 ? '(none)' : item.actualGroups.join(', ')}`);
  }

  console.log(`\nUNMATCHED (${conflicts.unmatched.length}):`);
  for (const item of conflicts.unmatched) {
    console.log(`  ✗ ${item.ceRecord.firstName} ${item.ceRecord.lastName} (${item.ceRecord.email})`);
    console.log(`    Reason: ${item.reason}`);
  }

  console.log(`\n========== SUMMARY ==========`);
  console.log(`Auto-reconcilable:  ${conflicts.autoReconcilable.length}`);
  console.log(`Needs confirmation: ${conflicts.needsConfirmation.length}`);
  console.log(`Needs review:       ${conflicts.needsReview.length}`);
  console.log(`Group mismatch:     ${conflicts.groupMismatch.length}`);
  console.log(`Unmatched:          ${conflicts.unmatched.length}`);
  console.log(`Total:              ${conflicts.autoReconcilable.length + conflicts.needsConfirmation.length + conflicts.needsReview.length + conflicts.groupMismatch.length + conflicts.unmatched.length}`);
}

/**
 * Perform write-back updates for auto-reconcilable records.
 */
async function performReconcile(conflicts) {
  console.log(`\n========== RECONCILIATION WRITE-BACK ==========\n`);

  for (const item of conflicts.autoReconcilable) {
    const { ceRecord, lglRecord, constituentId } = item;
    const ceAddr = {
      street: ceRecord.street,
      city: ceRecord.city,
      state: ceRecord.state,
      postal_code: ceRecord.zip,
    };

    const patchBody = {
      street_addresses: [ceAddr],
    };

    if (flags.dryRun) {
      console.log(`[DRY-RUN] Would update constituent #${constituentId}:`);
      console.log(`  ${ceRecord.firstName} ${ceRecord.lastName}`);
      console.log(`  New address: ${ceAddr.street}, ${ceAddr.city}, ${ceAddr.state} ${ceAddr.postal_code}`);
    } else {
      try {
        await patchConstituent(constituentId, patchBody);
        console.log(`✓ Updated constituent #${constituentId}: ${ceRecord.firstName} ${ceRecord.lastName}`);
      } catch (e) {
        console.error(`✗ Failed to update #${constituentId}:`, e.message);
      }
    }
  }

  console.log(`\nReconciliation complete.`);
}

/**
 * Initialize Google Sheets API client.
 */
function initializeGoogleSheets() {
  const clientSecretFile = process.env.OAUTH_CLIENT_SECRET_FILE || 'tokens/client_secret.json';
  const oauthTokenFile = process.env.OAUTH_TOKEN_FILE || 'tokens/oauth-token.json';

  if (!fs.existsSync(clientSecretFile) || !fs.existsSync(oauthTokenFile)) {
    console.error('Google OAuth files not found. Please set up OAuth tokens first.');
    return null;
  }

  try {
    const clientSecret = JSON.parse(fs.readFileSync(clientSecretFile, 'utf-8'));
    const oauthToken = JSON.parse(fs.readFileSync(oauthTokenFile, 'utf-8'));

    const auth = new google.auth.OAuth2({
      clientId: clientSecret.installed.client_id,
      clientSecret: clientSecret.installed.client_secret,
      redirectUrl: clientSecret.installed.redirect_uris[0],
    });

    auth.setCredentials({
      refresh_token: oauthToken.refresh_token,
    });

    return google.sheets({ version: 'v4', auth });
  } catch (e) {
    console.error('Failed to initialize Google Sheets:', e.message);
    return null;
  }
}

/**
 * Ensure required sheets exist, creating them if necessary.
 */
async function ensureSheets(sheets, spreadsheetId) {
  const requiredSheets = ['Summary', 'Auto-Reconcilable', 'Needs Confirmation', 'Needs Review', 'Group Mismatch', 'Unmatched'];

  try {
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const existingSheets = new Set(spreadsheet.data.sheets.map(s => s.properties.title));

    const sheetsToCreate = requiredSheets.filter(name => !existingSheets.has(name));

    if (sheetsToCreate.length > 0) {
      console.log(`Creating missing sheets: ${sheetsToCreate.join(', ')}`);

      const requests = sheetsToCreate.map(title => ({
        addSheet: {
          properties: {
            title,
          },
        },
      }));

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests },
      });
    }
  } catch (e) {
    console.error('Failed to ensure sheets exist:', e.message);
    throw e;
  }
}

/**
 * Write reconciliation results to Google Sheets.
 */
async function writeResultsToSheet(sheets, spreadsheetId, conflicts, ceRecordsCount, lglConstituentsCount) {
  if (!sheets) {
    console.log('Google Sheets not configured. Skipping sheet write.');
    return;
  }

  const timestamp = new Date().toISOString();

  try {
    // Ensure all required sheets exist
    await ensureSheets(sheets, spreadsheetId);

    // Clear existing data
    await sheets.spreadsheets.values.batchClear({
      spreadsheetId,
      requestBody: {
        ranges: ['Summary!A:Z', "'Auto-Reconcilable'!A:Z", "'Needs Confirmation'!A:Z", "'Needs Review'!A:Z", "'Group Mismatch'!A:Z", "'Unmatched'!A:Z"],
      },
    });

    // Write summary
    const summaryData = [
      ['Reconciliation Report', timestamp],
      [''],
      ['CE Records', ceRecordsCount],
      ['LGL Constituents', lglConstituentsCount],
      [''],
      ['Auto-Reconcilable', conflicts.autoReconcilable.length],
      ['Needs Confirmation', conflicts.needsConfirmation.length],
      ['Needs Review', conflicts.needsReview.length],
      ['Group Mismatch', conflicts.groupMismatch.length],
      ['Unmatched', conflicts.unmatched.length],
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Summary!A1',
      valueInputOption: 'RAW',
      requestBody: { values: summaryData },
    });

    // Write auto-reconcilable
    const autoRows = [
      ['First Name', 'Last Name', 'Email', 'Metro Area', 'CE Type', 'LGL ID', 'Match Type', 'Verdict', 'Confidence'],
      ...conflicts.autoReconcilable.map(item => [
        item.ceRecord.firstName,
        item.ceRecord.lastName,
        item.ceRecord.email,
        item.ceRecord._ceMetro || '',
        item.ceRecord._ceType || '',
        item.constituentId,
        item.matchType || '',
        item.verdict || '',
        item.confidence || '',
      ]),
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "'Auto-Reconcilable'!A1",
      valueInputOption: 'RAW',
      requestBody: { values: autoRows },
    });

    // Write needs confirmation
    const confirmRows = [
      ['First Name', 'Last Name', 'Email', 'Metro Area', 'CE Type', 'LGL ID', 'CE Address', 'LGL Address', 'Verdict', 'Confidence', 'Reason'],
      ...conflicts.needsConfirmation.map(item => [
        item.ceRecord.firstName,
        item.ceRecord.lastName,
        item.ceRecord.email,
        item.ceRecord._ceMetro || '',
        item.ceRecord._ceType || '',
        item.constituentId,
        item.ceAddress,
        item.lglAddress,
        item.verdict || '',
        item.confidence || '',
        item.reason || '',
      ]),
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "'Needs Confirmation'!A1",
      valueInputOption: 'RAW',
      requestBody: { values: confirmRows },
    });

    // Write needs review
    const reviewRows = [
      ['First Name', 'Last Name', 'Email', 'Metro Area', 'CE Type', 'LGL ID', 'CE Address', 'LGL Address', 'Issue', 'Reason'],
      ...conflicts.needsReview.map(item => [
        item.ceRecord.firstName,
        item.ceRecord.lastName,
        item.ceRecord.email,
        item.ceRecord._ceMetro || '',
        item.ceRecord._ceType || '',
        item.constituentId || '',
        item.ceAddress || '',
        item.lglAddress || '',
        item.issue || item.verdict || '',
        item.reason || '',
      ]),
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "'Needs Review'!A1",
      valueInputOption: 'RAW',
      requestBody: { values: reviewRows },
    });

    // Write group mismatch
    const mismatchRows = [
      ['First Name', 'Last Name', 'Email', 'Metro Area', 'CE Type', 'LGL ID', 'Expected Group', 'Actual Groups'],
      ...conflicts.groupMismatch.map(item => [
        item.ceRecord.firstName,
        item.ceRecord.lastName,
        item.ceRecord.email,
        item.ceRecord._ceMetro || '',
        item.ceRecord._ceType || '',
        item.constituentId,
        item.expectedGroup,
        item.actualGroups.join(', ') || '(none)',
      ]),
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "'Group Mismatch'!A1",
      valueInputOption: 'RAW',
      requestBody: { values: mismatchRows },
    });

    // Write unmatched
    const unmatchedRows = [
      ['First Name', 'Last Name', 'Email', 'Metro Area', 'CE Type', 'Reason', 'Candidates Count', 'Candidate Names'],
      ...conflicts.unmatched.map(item => {
        const candidateNames = (item.candidates || [])
          .map(c => `${c.first_name || '(no first)'} ${c.last_name || '(no last)'}`)
          .join(' | ');
        return [
          item.ceRecord.firstName,
          item.ceRecord.lastName,
          item.ceRecord.email,
          item.ceRecord._ceMetro || '',
          item.ceRecord._ceType || '',
          item.reason,
          item.candidates ? item.candidates.length : 0,
          candidateNames || '',
        ];
      }),
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "'Unmatched'!A1",
      valueInputOption: 'RAW',
      requestBody: { values: unmatchedRows },
    });

    console.log(`\nResults written to Google Sheet: ${spreadsheetId}`);
  } catch (e) {
    console.error('Failed to write to Google Sheets:', e.message);
  }
}

/**
 * Find group IDs by matching hardcoded group names.
 * Returns { memberGroupId, volunteerGroupId } or null if not found.
 */
async function findGroupIds() {
  const allGroups = await fetchAllGroups();

  let memberGroupId = null;
  let volunteerGroupId = null;

  for (const group of allGroups) {
    if (group.name === 'Member') {
      memberGroupId = group.id;
      console.log(`Found Member group (ID: ${group.id})`);
    }
    if (group.name === 'Volunteer') {
      volunteerGroupId = group.id;
      console.log(`Found Volunteer group (ID: ${group.id})`);
    }
  }

  if (!memberGroupId || !volunteerGroupId) {
    console.error('Could not find Members and/or Volunteers groups. Available groups:');
    for (const group of allGroups) {
      console.error(`  - "${group.name}" (ID: ${group.id})`);
    }
    return null;
  }

  return { memberGroupId, volunteerGroupId };
}

/**
 * Load CE members and service providers from a CSV dump file.
 */
function loadCERecordsFromCSV(csvContent, recordType = 'member') {
  const parsed = parseDumpChain(csvContent);
  const section = recordType === 'member' ? 'dump-member' : 'dump-service-provider';

  if (!parsed[section] || parsed[section].length === 0) {
    return [];
  }

  return parsed[section].map(record => {
    // Parse name field (format: "LastName, FirstName")
    const nameParts = (record['Name'] || '').split(',').map(s => s.trim());
    const lastName = nameParts[0] || '';
    const firstName = nameParts[1] || '';

    // Extract address components
    const street = record['Address'] || '';
    const city = record['City'] || '';
    const state = record['State'] || '';
    const zip = record['Zip'] || '';
    const email = record['Email'] || '';
    const phone = record['Phone'] || record['Cell Phone'] || record['Cell'] || '';

    return {
      firstName,
      lastName,
      email,
      phone,
      street,
      city,
      state,
      zip: zip ? zip.padStart(5, '0') : '', // Pad zip codes with leading zeros
      // Store CE metadata
      _ceMetro: record['Metro Area'],
      _ceName: record['Name'],
      _ceType: recordType,
    };
  });
}

/**
 * Entry point.
 */
async function main() {
  // Load CE records from CSV file if provided
  let ceRecords = [];
  const csvFile = process.env.CE_CSV_FILE;

  if (csvFile) {
    const fs = await import('fs');
    const csvContent = fs.readFileSync(csvFile, 'utf-8');

    // Load both members and service providers
    const members = loadCERecordsFromCSV(csvContent, 'member');
    const providers = loadCERecordsFromCSV(csvContent, 'provider');
    ceRecords = [...members, ...providers];

    console.log(`Loaded ${members.length} members and ${providers.length} service providers from CE dump\n`);
  } else {
    console.log('No CE records provided. Set CE_CSV_FILE environment variable to load records.');
    console.log('Expected format: CSV dump from Club Express with dump-member and dump-service-provider sections');
    return;
  }

  if (ceRecords.length === 0) {
    console.log('No CE records found in CSV file.');
    return;
  }

  // Load ALL LGL constituents
  console.log('Loading all LGL constituents...\n');
  const results = await searchConstituents({
    expand: 'email_addresses,street_addresses,phone_numbers,groups',
    limit: 2500,
  });
  const lglConstituents = results.items || [];

  console.log(`Total LGL constituents loaded: ${lglConstituents.length}\n`);

  const conflicts = await reconcile(ceRecords, lglConstituents);

  if (flags.report) {
    generateReport(conflicts);
  }

  if (flags.reconcile) {
    await performReconcile(conflicts);
  }

  // Write to Google Sheets if configured
  const spreadsheetId = process.env.RECONCILIATION_SPREADSHEET_ID;
  if (spreadsheetId) {
    const sheets = initializeGoogleSheets();
    await writeResultsToSheet(sheets, spreadsheetId, conflicts, ceRecords.length, lglConstituents.length);
  } else {
    console.log('\nTo write results to Google Sheets, set RECONCILIATION_SPREADSHEET_ID environment variable.');
  }
}

main().catch(console.error);
