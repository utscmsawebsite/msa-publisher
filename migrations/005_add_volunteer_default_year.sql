-- Adds an optional "default year" to the volunteer system: the year that the
-- report forms open on, so execs don't have to hunt for it. At most one year
-- can be the default (the unique index enforces it). No default is set by
-- this migration; until an admin picks one, forms fall back to the year that
-- contains today's date, exactly as before.
--
-- This only ADDS a column and an index. Nothing existing is changed.
BEGIN;

ALTER TABLE volunteer_years
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS volunteer_years_one_default_idx
  ON volunteer_years (is_default)
  WHERE is_default;

COMMIT;
