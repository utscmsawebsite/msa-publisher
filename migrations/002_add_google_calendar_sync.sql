-- Adds Google Calendar sync tracking columns.
-- IF NOT EXISTS guards make this safe to rerun.

BEGIN;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS google_calendar_event_id text;

ALTER TABLE jummah
  ADD COLUMN IF NOT EXISTS google_calendar_first_event_id text,
  ADD COLUMN IF NOT EXISTS google_calendar_second_event_id text;

COMMIT;
