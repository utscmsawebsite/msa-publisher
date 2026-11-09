# Database Schema Audit — `jummah` table

**Finding:** The live production `jummah` table does not match `migrations/001_create_content_tables.sql`. Two separate discrepancies were found.

## 1. Column type mismatch

| Column | Migration file (`001`) | Live production |
|---|---|---|
| `first_start_time` | `time` | `text` |
| `first_end_time` | `time` | `text` |
| `second_start_time` | `time` | `text` |
| `second_end_time` | `time` | `text` |

## 2. Missing CHECK constraints

The migration file defines two constraints that are not present on the live table:

```sql
CONSTRAINT jummah_first_time_order CHECK (first_end_time > first_start_time)
CONSTRAINT jummah_second_time_order CHECK (
  second_start_time IS NULL OR second_end_time IS NULL OR second_end_time > second_start_time
)
```

Live schema only has `jummah_id_check`, `jummah_second_khutbah_complete`, and `jummah_unavailable_message_required` — the two time-ordering constraints above are absent.

## Evidence

- Direct query against the live database (`\d jummah`) confirms both points above.
- `neon-jummah.repository.ts` contains a `time()` parser that normalizes loose text formats (including AM/PM) before use — code that only makes sense against a column that isn't already a validated `time` type.
- Two commits reference this directly: `"Handle text-formatted Jummah times"` and `"Normalize Jummah times for Slack"`.

## Likely explanation

The column type was changed directly against production at some point (not via a migration file), and the two CHECK constraints were dropped in the same change — plausibly because `end_time > start_time` as a *text* comparison is unreliable for non-zero-padded or AM/PM values and would have started rejecting valid submissions.

## Impact

Anyone bootstrapping a new database from `001` alone (a second environment, a fresh local setup, disaster recovery) would get a schema that diverges from production in a way that isn't documented anywhere in the repo.

## Not at risk

Current production behavior. `jummah.service.ts` already validates time ordering in the application layer independently of the DB, so the missing constraints aren't causing any live bug — this is a documentation/consistency gap, not an active issue.

## Open question

Why were the CHECK constraints dropped in the first place? If it was a deliberate call to move validation to the app layer, restoring them is fine. If it was collateral damage from an unrelated fix, also fine. But if they were dropped because something specific was failing (some edge case, an admin script, a direct DB edit that doesn't go through the app), restoring them blind could start rejecting that same thing again — and there's no way to know that from the repo alone. That's a real "why," not just risk-aversion for its own sake. The answer determines whether the fix is "write a migration documenting text-as-correct" or "write a migration restoring `time` + the constraints and fixing the app accordingly."
