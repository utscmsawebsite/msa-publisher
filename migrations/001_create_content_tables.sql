-- Initial database schema for a fresh installation.
-- IF NOT EXISTS guards make this safe to rerun after a successful setup.

BEGIN;

CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL,
  event_date date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  image_urls text[] NOT NULL,
  slack_submission_id text NOT NULL,
  created_by_slack_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT event_time_order CHECK (
    end_time > start_time
  ),

  CONSTRAINT event_has_images CHECK (
    cardinality(image_urls) BETWEEN 1 AND 5
  )
);

CREATE INDEX IF NOT EXISTS events_event_date_time_idx
  ON events (event_date, start_time);

CREATE UNIQUE INDEX IF NOT EXISTS events_slack_submission_id_idx
  ON events (slack_submission_id);

CREATE TABLE IF NOT EXISTS jummah (
  id text PRIMARY KEY CHECK (id = 'current'),
  first_start_time time NOT NULL,
  first_end_time time NOT NULL,
  first_location text NOT NULL,
  second_start_time time,
  second_end_time time,
  second_location text,
  updated_by_slack_user_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT jummah_first_time_order CHECK (
    first_end_time > first_start_time
  ),

  CONSTRAINT jummah_second_time_order CHECK (
    second_start_time IS NULL
    OR second_end_time IS NULL
    OR second_end_time > second_start_time
  ),

  CONSTRAINT jummah_second_khutbah_complete CHECK (
    (
      second_start_time IS NULL
      AND second_end_time IS NULL
      AND second_location IS NULL
    )
    OR
    (
      second_start_time IS NOT NULL
      AND second_end_time IS NOT NULL
      AND second_location IS NOT NULL
    )
  )
);

COMMIT;
