# LGL Reconciliation Tool

Reconcile Club Express (CE) member and service provider records against Little Green Light (LGL) constituents. Identifies matches, validates group membership, compares addresses, and writes results to Google Sheets.

## Quick Start

### Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env with your API keys and file paths
   ```

   Required:
   - `LGL_API_KEY` - Little Green Light API key
   - `ANTHROPIC_API_KEY` - Claude API key
   - `CE_CSV_FILE` - Path to Club Express dump-chain.csv export

   Optional:
   - `RECONCILIATION_SPREADSHEET_ID` - Google Sheets ID for results
   - `OAUTH_CLIENT_SECRET_FILE` - Google OAuth config
   - `OAUTH_TOKEN_FILE` - Google OAuth token

### Run

```bash
# Generate reconciliation report
npm run reconcile:report

# Preview auto-updates (dry-run)
npm run reconcile:dry-run

# Apply auto-reconcilable updates to LGL
npm run reconcile
```

Or use the underlying command:
```bash
node reconcile.js --report
node reconcile.js --reconcile --dry-run
node reconcile.js --reconcile
```

## What It Does

1. **Loads CE records** from CSV dump (members & service providers)
2. **Fetches all LGL constituents** with email, address, phone, and group data
3. **Matches records** using email-first strategy with name fallback
4. **Validates groups** - members must be in "Member" group, providers in "Volunteer"
5. **Compares addresses** - classifies as exact match, different, or ambiguous
6. **Evaluates ambiguous addresses** using Claude AI for intelligent matching
7. **Categorizes results** into 5 outcome buckets
8. **Writes to Google Sheets** for human review
9. **Auto-updates LGL** for high-confidence matches (optional)

## Output Categories

| Category | Count | Meaning | Action |
|----------|-------|---------|--------|
| **Auto-Reconcilable** | 525 | Email match + exact address | Automatically update LGL (--reconcile) |
| **Needs Confirmation** | 17 | Claude verdict "likely_same" < 0.8 confidence | Human review required |
| **Needs Review** | 23 | Address mismatch or unclear case | Determine if address changed |
| **Group Mismatch** | 710 | Matched but missing correct group | Add group to LGL constituent |
| **Unmatched** | 130 | No LGL match found | Manual lookup / add to LGL |

**Total**: 1,405 CE records processed

## Matching Strategy

### Email (Primary)
- Searches for exact email match in LGL
- If 1 match found → success
- If 2+ matches → try name tie-breaker

### Name Tie-Breaker
- If multiple email matches AND CE record has name
- Check if any match has exact same first + last name
- If found → use that match
- If not found → fall through to name search

### Name Search (Fallback)
- If email fails or tie-breaker fails
- Search for exact first + last name match
- Requires BOTH names non-empty in both CE and LGL
- Returns match if exactly 1 found, unmatched if 0 or 2+

## Features

### Caching

All API responses and Claude evaluations are cached automatically.

```bash
# Use cache (default, fast)
npm run reconcile:report

# Force fresh API calls
npm run reconcile:report -- --no-cache

# Skip Claude address evaluation
npm run reconcile:report -- --no-claude-api
```

**Cache location**: `lgl-cache/`
- **API responses**: By path + parameters (e.g., constituents/search)
- **Claude verdicts**: Single file by constituent_id (`claude-verdicts.json`)

### Debug Mode

```bash
node reconcile.js --report --debug
```

Shows matching logic for each record:
- Which email/name searches are attempted
- What results are found
- Why matches succeeded or failed

## Data Quality

### Issues Found

**LGL has 77 records (3.6%) with incomplete names:**
- 33 records with no first or last name (likely placeholders)
- 7 records missing first name (mostly organizations)
- 37 records missing last name (many generic "Friends" entries)

**LGL has duplicate records:**
- Example: `parents6386@gmail.com` assigned to two "Roger Lamarre" records
- Flagged as `multiple_email_matches` for manual review

**CE CSV contains:**
- 782 members in dump-member section
- 623 service providers in dump-service-provider section
- Service request categories in separate sections (not loaded)

### Reconciliation Helps Identify

- Members without "Member" group assignment
- Service providers without "Volunteer" group assignment
- Address changes between CE and LGL
- Duplicate/incomplete records in LGL

## Google Sheets Integration

Results automatically written to Google Sheets with 6 tabs:

1. **Summary** - Record counts and statistics
2. **Auto-Reconcilable** - Ready for update
3. **Needs Confirmation** - Claude "likely_same" matches
4. **Needs Review** - Address mismatches and unclear cases
5. **Group Mismatch** - Wrong group assignments
6. **Unmatched** - No LGL match found (with candidate names)

Set `RECONCILIATION_SPREADSHEET_ID` in `.env` to enable.

## Claude Address Evaluation

When two addresses are similar but not identical:

1. **Pre-filter** - Normalize and classify addresses
   - Exact match (same street + zip) → auto-reconcilable
   - Different zip → needs review
   - Ambiguous → send to Claude

2. **Claude evaluates** ambiguous pairs in batches
   - Returns verdict: "exact", "likely_same", or "different"
   - Returns confidence: 0.0 - 1.0
   - Returns recommended action

3. **Results used for**:
   - Confidence ≥ 0.8 → auto-reconcilable
   - Confidence < 0.8 → needs confirmation
   - Different verdict → needs review

**First run**: Sends ~100-120 ambiguous addresses to Claude (takes ~30 seconds)
**Subsequent runs**: Uses cached verdicts (instant)

## Common Issues & Solutions

### "No LGL match found" (Unmatched)

**Causes**:
- Email doesn't exist in LGL (constituent missing)
- Name in CE doesn't exactly match LGL
- LGL record has incomplete name
- Email shared by multiple people (different names)

**Solutions**:
- Check "Candidate Names" column in Unmatched sheet
- Add missing constituent to LGL
- Verify name spelling in CE vs LGL
- Contact person to clarify email ownership

### "Group Mismatch"

**Cause**: Constituent matched but wrong group assignment

**Solution**: 
- Add "Member" group to members
- Add "Volunteer" group to service providers
- Or move constituent between appropriate groups

### "Needs Review" for address

**Cause**: CE address differs from LGL address

**Solutions**:
- Update LGL to match CE (CE is golden record)
- Or update CE if LGL address is more current
- Check if constituent moved

### Multiple candidates for same name

**Cause**: LGL has duplicate records with same email/name

**Solution**:
- Merge duplicate records in LGL
- Delete one record if truly duplicate
- Differentiate if they're different people (add middle names, suffixes)

## CLI Reference

```bash
node reconcile.js (--report | --reconcile) [OPTIONS]

Required:
  --report              Generate reconciliation report and write to Sheets
  --reconcile           Apply auto-reconcilable updates to LGL (requires --dry-run first)

Options:
  --dry-run             Preview updates without applying (use with --reconcile)
  --no-claude-api       Skip Claude address evaluation (all ambiguous → Needs Review)
  --no-cache            Ignore cached API responses and Claude verdicts, fetch fresh
  --debug               Verbose output for matching logic
```

## Environment Variables

```bash
# Required
LGL_API_KEY=your_lgl_api_key
ANTHROPIC_API_KEY=your_claude_api_key
CE_CSV_FILE=/path/to/dump-chain.csv

# Optional (Google Sheets)
RECONCILIATION_SPREADSHEET_ID=your_sheet_id
OAUTH_CLIENT_SECRET_FILE=tokens/client_secret.json
OAUTH_TOKEN_FILE=tokens/oauth-token.json
```

## Performance

- **First run**: ~45 seconds (API calls + Claude evaluation)
- **Subsequent runs**: ~2 seconds (fully cached)
- **API cache size**: ~5-7 MB
- **Claude verdict cache**: ~37 KB (for 120 addresses)

Cache is persistent; delete `lgl-cache/` to reset.

## Limitations & Next Steps

### Current Limitations
- Address normalization is rule-based (not USPS API)
- Updates are one-at-a-time (not batch)
- No web UI for reviewing matches
- Requires manual Google Sheets access for editing

### Planned Improvements
- USPS API integration for address validation
- Batch PATCH updates to LGL
- Phone number matching as tertiary fallback
- Address fuzzy matching to reduce Claude calls
- Duplicate detection in CE data
- Web UI for match review and confirmation

## Support

For issues or questions:
- Check `CLAUDE.md` for architecture decisions and design rationale
- Run with `--debug` to see matching logic details
- Review Google Sheets results for data quality insights
- Check `lgl-cache/` for API response details
