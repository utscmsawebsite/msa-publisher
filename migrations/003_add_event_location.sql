-- Adds an event location field.
-- Nullable with no default: safe to add to a table with existing rows.
-- Required-ness is enforced at the application layer for new submissions,
-- matching how title/description are already handled.
-- IF NOT EXISTS guard makes this safe to rerun.

BEGIN;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS location text;

COMMIT;
