import dotenv from 'dotenv';
dotenv.config();

import Anthropic from '@anthropic-ai/sdk';
import { searchConstituents, fetchConstituentDetails, patchConstituent } from './lgl.js';
import { parseDumpChain } from '../ce-sheets-sync/lib/dump-chain-processor.js';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Parse CLI flags
const args = process.argv.slice(2);
const flags = {
  report: args.includes('--report'),
  reconcile: args.includes('--reconcile'),
  dryRun: args.includes('--dry-run'),
};

if (!flags.report && !flags.reconcile) {
  console.error('Usage: node reconcile.js (--report | --reconcile) [--dry-run]');
  process.exit(1);
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
 * Send ambiguous address pairs to Claude for evaluation in batches.
 */
async function evaluateAmbiguousAddresses(ambiguous) {
  const batchSize = 20;
  const verdicts = {};

  for (let i = 0; i < ambiguous.length; i += batchSize) {
    const batch = ambiguous.slice(i, i + batchSize);
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

    try {
      const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const batchVerdicts = JSON.parse(jsonMatch[0]);
        for (const v of batchVerdicts) {
          verdicts[v.constituent_id] = v;
        }
      }
    } catch (e) {
      console.error('Failed to parse Claude response:', e.message);
    }
  }

  return verdicts;
}

/**
 * Match a CE member/volunteer to an LGL constituent.
 * Strategy: primary match on email, secondary on name.
 */
async function matchCERecordToLGL(ceRecord) {
  const { firstName, lastName, email } = ceRecord;

  // Try email first
  if (email) {
    const results = await searchConstituents({
      email: email,
    });
    if (results.items && results.items.length === 1) {
      return { matched: true, constituentId: results.items[0].id, lglRecord: results.items[0], matchType: 'email_exact' };
    }
    if (results.items && results.items.length > 1) {
      return { matched: false, reason: 'multiple_email_matches', candidates: results.items };
    }
  }

  // Fall back to name search
  if (firstName && lastName) {
    const fullName = `${firstName} ${lastName}`;
    const results = await searchConstituents({
      name: fullName,
    });
    if (results.items && results.items.length === 1) {
      return { matched: true, constituentId: results.items[0].id, lglRecord: results.items[0], matchType: 'name_exact' };
    }
    if (results.items && results.items.length > 1) {
      return { matched: false, reason: 'multiple_name_matches', candidates: results.items };
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
 * Main reconciliation workflow.
 */
async function reconcile(ceRecords) {
  console.log(`Starting reconciliation for ${ceRecords.length} CE records...\n`);

  const conflicts = {
    autoReconcilable: [],
    needsConfirmation: [],
    needsReview: [],
    unmatched: [],
  };

  const addressPairs = [];

  // Phase 1: Match CE records to LGL
  for (const ceRecord of ceRecords) {
    const match = await matchCERecordToLGL(ceRecord);

    if (!match.matched) {
      conflicts.unmatched.push({
        ceRecord,
        reason: match.reason,
        candidates: match.candidates || [],
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

  // Ambiguous go to Claude
  if (ambiguous.length > 0) {
    console.log(`Sending ${ambiguous.length} ambiguous addresses to Claude for evaluation...\n`);
    const verdicts = await evaluateAmbiguousAddresses(ambiguous);

    for (const pair of ambiguous) {
      const verdict = verdicts[pair.constituentId];
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

  console.log(`\nUNMATCHED (${conflicts.unmatched.length}):`);
  for (const item of conflicts.unmatched) {
    console.log(`  ✗ ${item.ceRecord.firstName} ${item.ceRecord.lastName} (${item.ceRecord.email})`);
    console.log(`    Reason: ${item.reason}`);
  }

  console.log(`\n========== SUMMARY ==========`);
  console.log(`Auto-reconcilable:  ${conflicts.autoReconcilable.length}`);
  console.log(`Needs confirmation: ${conflicts.needsConfirmation.length}`);
  console.log(`Needs review:       ${conflicts.needsReview.length}`);
  console.log(`Unmatched:          ${conflicts.unmatched.length}`);
  console.log(`Total:              ${conflicts.autoReconcilable.length + conflicts.needsConfirmation.length + conflicts.needsReview.length + conflicts.unmatched.length}`);
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
      zip,
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

  const conflicts = await reconcile(ceRecords);

  if (flags.report) {
    generateReport(conflicts);
  }

  if (flags.reconcile) {
    await performReconcile(conflicts);
  }
}

main().catch(console.error);
