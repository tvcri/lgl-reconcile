# LGL Reconciliation Tool - Development Guide

## Project Overview

The LGL Reconciliation Tool matches Club Express (CE) member and service provider records against Little Green Light (LGL) constituent records. It identifies matches, validates group membership, compares addresses (with Claude assistance for ambiguous cases), and writes results to Google Sheets for review and action.

**Golden Record Principle**: CE data is the authoritative source. LGL records should be updated to match CE data where discrepancies are found.

## Architecture

### Core Files

- **lgl.js** - LGL API client with caching
- **reconcile.js** - Main reconciliation engine and matching logic
- **index.js** - Test/development entry point (not used for production)

### Data Flow

1. Load CE records from CSV dump (members and service providers only)
2. Fetch all LGL constituents with expanded data (emails, addresses, phone numbers, groups)
3. Match each CE record to LGL constituents using email → name fallback
4. Validate group membership (members must be in "Member" group, providers in "Volunteer")
5. Compare addresses (exact → ambiguous → Claude evaluation)
6. Categorize results (auto-reconcilable, needs confirmation, needs review, group mismatch, unmatched)
7. Write results to Google Sheets
8. Auto-update reconcilable records (optional, with --reconcile flag)

## Key Design Decisions

### 1. Always Load All LGL Constituents
**Decision**: Removed group-based filtering. Always fetch all constituents from LGL.

**Rationale**: 
- Initial approach searched only constituents in "Member" and "Volunteer" groups
- Discovered constituents in other groups (e.g., Westerly, Wood River) were being marked unmatched
- LGL groups are fluid; a constituent might legitimately be in non-standard groups
- Better to have false positives (group mismatch) than false negatives (unmatched)

**Implementation**: `searchConstituents()` with `expand: 'email_addresses,street_addresses,phone_numbers,groups'` and `limit: 2500` fetches all ~2132 constituents in a single cached call.

### 2. Email-First Matching with Name Fallback
**Decision**: Match by email first, then fall back to name search if email fails.

**Matching Strategy**:
1. **Email exact match** (case-insensitive): If 1 match → success
2. **Email multiple matches with name tie-break**: If email returns 2+ matches and CE record has name, check if any match has exact same name
3. **Name exact match fallback**: If email fails or tie-break fails, search by exact first + last name
4. Return unmatched only if all strategies fail

**Code Location**: `matchCERecordToLGLArray()` in reconcile.js, lines 221-303

### 3. Strict Name Matching (No Partial Matches)
**Decision**: Require exact match on BOTH first AND last name, both non-empty.

**Previous Bug**: Early implementation used substring matching (`fullName.includes(searchName)`), which matched:
- Any constituent with first name "Nancy" to "Nancy Pirnie" search
- Any constituent with last name "Pirnie" to "Nancy Pirnie" search
- Empty/null names to any search (matched everyone)

**Result**: "Nancy Pirnie" had 34 false candidate matches (mostly empty-name records and single-name matches)

**Fix**: 
```javascript
const cFirstName = (c.first_name || '').trim().toLowerCase();
const cLastName = (c.last_name || '').trim().toLowerCase();
const searchFirstName = firstName.trim().toLowerCase();
const searchLastName = lastName.trim().toLowerCase();

if (!cFirstName || !cLastName || !searchFirstName || !searchLastName) {
  return false;
}

return cFirstName === searchFirstName && cLastName === searchLastName;
```

**Impact**: Unmatched count dropped from 670 to 130 by eliminating false matches.

### 4. API Response Caching
**Decision**: Cache all LGL API responses by path + parameters.

**Implementation**:
- Cache directory: `lgl-cache/`
- Cache key: Path + sorted parameters (e.g., `_constituents_search_expand_email_addresses_street_addresses_phone_numbers_groups_limit_2500_q___groups_3282_2C3267.json`)
- **Default**: Caching enabled (use `--no-cache` to disable)
- First run fetches from API and caches; subsequent runs use cache (instant)

**Rationale**: API calls are slow; caching eliminates network latency on development/testing iterations.

### 5. Claude Address Evaluation Caching
**Decision**: Cache Claude verdicts by constituent_id in a single persistent file.

**Implementation**:
- Cache file: `lgl-cache/claude-verdicts.json`
- Structure: `{ "constituent_id": { verdict, confidence, reason, recommended_action }, ... }`
- **Loading**: Load all verdicts at start; only evaluate new constituent_ids
- **Saving**: Append new verdicts to existing cache

**Behavior**:
- First run with 120 ambiguous addresses: Calls Claude 12 times (batches of 10), takes ~30 seconds, caches results
- Second run: Loads all 120 verdicts from cache instantly (message: `[CACHE] All 120 verdicts loaded from cache`)
- Subsequent runs with new addresses: Only new constituents sent to Claude, cached results reused

**Rationale**: Claude API calls are expensive and slow. Once evaluated, a constituent's address pair should never be re-evaluated.

### 6. Groups: Field Name is `group_name`, Not `name`
**Decision**: Access group names via `group.group_name` field from LGL API.

**Bug Found**: Initial code used `g.name` which returned `null`, displaying groups as empty.

**Fix**: Changed `g.name` → `g.group_name` in two places:
- Line 321: Building `actualGroups` array for Group Mismatch conflicts
- Line 284: In `isConstituentInGroup()` function

**Group Object Structure** (from search/expand):
```javascript
{
  "id": 604712,
  "constituent_id": 948971,
  "group_id": 3267,
  "group_name": "Volunteer",  // ← This is the field
  "date_start": null,
  "date_end": null,
  "is_current": true,
  "created_at": "2025-09-16T20:04:07Z",
  "updated_at": "2025-09-16T20:04:07Z"
}
```

### 7. CSV Parsing: Members and Service Providers Only
**Decision**: Load only `dump-member` and `dump-service-provider` sections from CE CSV dump.

**Why**: CE dump contains multiple sections:
- `dump-member` (782 records)
- `dump-service-provider` (623 records)
- `dump-service-requested`, `dump-service-history`, `dump-service-provider-category` (not used)

The unused sections contain service requests and categories, not unique records.

**Implementation**: `loadCERecordsFromCSV()` uses `parseDumpChain()` to extract specific sections, skips others.

### 8. Zip Code Normalization
**Decision**: Pad zip codes with leading zeros to 5 digits.

**Rationale**: CE CSV dump has zip codes like "2891" that should be "02891" for Rhode Island. CSV parsing strips leading zeros.

**Implementation**: 
```javascript
zip: zip ? zip.padStart(5, '0') : ''
```

## Data Quality Issues Found

### LGL Records with Missing Names
- **33 records**: No first or last name, no email (placeholder records)
- **7 records**: No first name (mostly organizations: Barrington Prevention Coalition, Macdonald Family Trust, etc.)
- **37 records**: No last name (many are generic "Friends" entries or single-name records)
- **Total**: 77 records (3.6% of 2,132) have incomplete names

**Impact**: Matching logic now correctly skips constituents with missing name fields.

### LGL Records with Duplicate Email
- Example: `parents6386@gmail.com` assigned to two different "Roger Lamarre" records (IDs 953282 and 955457)
- Both have identical name and email (genuine duplicate data)
- Marked as `multiple_email_matches` in results for review

### CE Records Appearing in Multiple CSV Sections
- Nancy Pirnie appears in `dump-service-provider` once (provider record) and `dump-service-provider-category` three times (request categories)
- Only the provider record is loaded; categories are ignored (correct behavior)

## Result Categories

### Auto-Reconcilable (525 records)
- Email match with exact address OR
- Ambiguous address evaluated by Claude with confidence ≥0.8 and verdict "exact" or "likely_same"
- **Action**: Automatically update LGL address to match CE (with --reconcile flag)

### Needs Confirmation (17 records)
- Claude verdict "likely_same" with confidence < 0.8
- **Action**: Human review required before updating

### Needs Review (23 records)
- Address mismatch (different zip code)
- Claude verdict "different"
- Ambiguous address (skipped Claude evaluation with --no-claude-api flag)
- **Action**: Human review; determine if address changed or if it's a mismatch

### Group Mismatch (710 records)
- Matched to LGL record but missing expected group assignment
- Members without "Member" group OR providers without "Volunteer" group
- **Action**: Add correct group to LGL constituent

### Unmatched (130 records)
- No email match in LGL
- Name search found either 0 matches, multiple matches, or only empty-name matches
- **Sub-reasons**:
  - `no_match`: Email and name both fail
  - `multiple_name_matches`: Name search returns 2+ constituents (ambiguous)
  - `multiple_email_matches`: Email search returns 2+ constituents AND name tie-break fails
- **Action**: Manual lookup; possibly add missing constituent to LGL

## CLI Flags

```bash
node reconcile.js (--report | --reconcile) [--dry-run] [--no-claude-api] [--no-cache] [--debug]
```

- **--report**: Generate reconciliation report (shows all conflicts)
- **--reconcile**: Apply auto-reconcilable updates (requires --dry-run to preview)
- **--dry-run**: Preview updates without applying (used with --reconcile)
- **--no-claude-api**: Skip Claude address evaluation; all ambiguous addresses go to "Needs Review"
- **--no-cache**: Ignore cached API responses and Claude verdicts, fetch fresh
- **--debug**: Verbose output for matching logic (shows each step)

**Typical workflows**:
```bash
# See what needs reconciliation
node reconcile.js --report

# Preview updates before applying
node reconcile.js --reconcile --dry-run

# Apply auto-reconcilable updates
node reconcile.js --reconcile

# Test without waiting for Claude (all ambiguous → review)
node reconcile.js --report --no-claude-api

# Force fresh API calls (clear cache)
node reconcile.js --report --no-cache
```

## Environment Variables

```bash
LGL_API_KEY=<your_lgl_api_key>
ANTHROPIC_API_KEY=<your_anthropic_api_key>
CE_CSV_FILE=/path/to/dump-chain.csv
RECONCILIATION_SPREADSHEET_ID=<google_sheets_id>
OAUTH_CLIENT_SECRET_FILE=tokens/client_secret.json
OAUTH_TOKEN_FILE=tokens/oauth-token.json
```

## Google Sheets Output

Results written to 8 sheets:

1. **Summary**: Record counts per category
2. **Auto-Reconcilable**: Ready for auto-update (email match + exact address)
3. **Needs Confirmation**: Claude verdict "likely_same" < 0.8 confidence
4. **Needs Review**: Address mismatches or unclear cases
5. **Group Mismatch**: Matched but missing correct group
6. **Unmatched**: No LGL match found

All sheets include:
- **Standard columns**: First Name, Last Name, Email, Metro Area, CE Type, LGL ID
- **Reason/Verdict**: Why it's in this category
- **Addresses**: CE and LGL addresses (where applicable)
- **Actual Groups**: Constituent's current groups in LGL

For Unmatched sheet:
- **Candidates Count**: Number of potential matches found
- **Candidate Names**: Full list of candidate names (new column added this session)

## Code Quality Notes

### What to Avoid

- **Substring name matching**: We learned this causes massive false positives. Require exact matches.
- **Loose type coercion**: Always check for empty strings and null explicitly (e.g., `!cFirstName` not just `if (cFirstName)`)
- **Breaking early from matching attempts**: If email tie-break fails, fall through to name search instead of returning unmatched immediately
- **Trusting partial LGL data**: Don't match on name if either first or last name is missing in either record

### Tested and Validated

- Email-first strategy with name fallback works well
- Strict name matching eliminates false positives
- Caching (both API and Claude) dramatically speeds up iteration
- Address ambiguity classification (exact/different/ambiguous) followed by Claude evaluation is effective
- Group membership validation catches data quality issues

## Future Improvements

- USPS API integration for address normalization (currently manual)
- Batch PATCH updates to LGL (currently one-at-a-time)
- Phone number matching as tertiary fallback
- Address fuzzy matching before Claude (reduce Claude calls)
- Duplicate detection in CE data (currently passes through)
- Web UI for reviewing and confirming matches

## Oncall/Production Considerations

- Cache files grow over time but remain under 10MB (benign)
- Claude API costs scale with ambiguous addresses; use --no-claude-api to preview before running
- LGL API has rate limits; caching helps but don't repeatedly run --no-cache
- Google Sheets API requires valid OAuth tokens; keep tokens/client_secret.json secure
- CE CSV dump should be fresh; stale data leads to false unmatched records
