CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL,
  publish_date date,
  publish_time time,
  event_date date NOT NULL,
  image_urls text[] NOT NULL,
  created_by_slack_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT publish_schedule_complete CHECK (
    (publish_date IS NULL AND publish_time IS NULL)
    OR
    (publish_date IS NOT NULL AND publish_time IS NOT NULL)
  ),

  CONSTRAINT event_has_images CHECK (
    cardinality(image_urls) BETWEEN 1 AND 5
  )
);

CREATE INDEX IF NOT EXISTS events_event_date_idx
  ON events (event_date);

CREATE INDEX IF NOT EXISTS events_publish_schedule_idx
  ON events (publish_date, publish_time)
  WHERE publish_date IS NOT NULL;
