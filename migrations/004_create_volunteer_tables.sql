-- Volunteer hours system (runs in the community-volunteering Slack workspace).
--
-- This only creates new tables and indexes; it changes nothing that exists, and
-- it runs in one transaction so a failure leaves nothing half-applied. The IF NOT
-- EXISTS guards and ON CONFLICT seed make it safe to rerun, but rerunning only
-- adds what is missing: it does not alter a table that an older version of this
-- file already created.
--
-- Apply by hand with psql, then confirm the live schema with \d.

BEGIN;

CREATE TABLE IF NOT EXISTS volunteer_years (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT volunteer_years_date_order CHECK (end_date > start_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS volunteer_years_label_idx
  ON volunteer_years (lower(label));

-- A volunteer is identified by their student number (unique per student type),
-- not by Slack. slack_user_id is the row's key: a Slack user ID once the
-- volunteer is on Slack, or an 'ext_...' placeholder for a volunteer an exec
-- added who has no Slack account yet. The app re-keys the row to the real Slack
-- ID when that volunteer later signs in with matching details, and ON UPDATE
-- CASCADE carries their submissions along.
--
-- Fields follow the MSA general volunteer sign-up form: first and last name, a
-- preferred contact email (everyone), the email asked for in the volunteer's
-- section (UofT email / university email / email), UTORid (UofT only), and a
-- student number or ID (every type).
CREATE TABLE IF NOT EXISTS volunteer_profiles (
  slack_user_id text PRIMARY KEY,
  student_type text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  full_name text GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED,
  -- Asked of everyone on the first page of the sign-up form: where to reach them.
  preferred_email text NOT NULL,
  -- The email asked for in the volunteer's own section (UofT email, university
  -- email, or email).
  email text NOT NULL,
  utorid text,
  student_number text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT volunteer_profiles_student_type CHECK (
    student_type IN ('uoft', 'other_university', 'high_school')
  ),

  CONSTRAINT volunteer_profiles_uoft_utorid CHECK (
    student_type <> 'uoft' OR utorid IS NOT NULL
  ),

  CONSTRAINT volunteer_profiles_names CHECK (
    NULLIF(BTRIM(first_name), '') IS NOT NULL
    AND NULLIF(BTRIM(last_name), '') IS NOT NULL
    AND NULLIF(BTRIM(student_number), '') IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS volunteer_profiles_utorid_idx
  ON volunteer_profiles (lower(utorid))
  WHERE utorid IS NOT NULL;

-- The identity key: one volunteer per (student type, student number), ignoring
-- case so an ID typed as "ab123" and "AB123" is the same person.
CREATE UNIQUE INDEX IF NOT EXISTS volunteer_profiles_student_key_idx
  ON volunteer_profiles (student_type, lower(student_number));

CREATE TABLE IF NOT EXISTS volunteer_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  requires_event boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS volunteer_categories_name_idx
  ON volunteer_categories (lower(name));

CREATE TABLE IF NOT EXISTS volunteer_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  event_date date,
  is_active boolean NOT NULL DEFAULT true,
  created_by_slack_user_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS volunteer_staff (
  slack_user_id text PRIMARY KEY,
  display_name text,
  title text,
  can_approve boolean NOT NULL DEFAULT false,
  can_manage boolean NOT NULL DEFAULT false,
  is_primary boolean NOT NULL DEFAULT false,
  added_by_slack_user_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS volunteer_staff_single_primary_idx
  ON volunteer_staff (is_primary)
  WHERE is_primary;

CREATE TABLE IF NOT EXISTS volunteer_report_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generated_by_slack_user_id text NOT NULL,
  year_id uuid NOT NULL REFERENCES volunteer_years (id),
  kind text NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  entry_count integer NOT NULL,
  total_hours numeric(8, 2) NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  marked_sent_at timestamptz,
  marked_sent_by_slack_user_id text,

  CONSTRAINT volunteer_report_exports_kind CHECK (
    kind IN ('combined', 'letterhead')
  ),

  CONSTRAINT volunteer_report_exports_sent_consistent CHECK (
    (marked_sent_at IS NULL AND marked_sent_by_slack_user_id IS NULL)
    OR (marked_sent_at IS NOT NULL AND marked_sent_by_slack_user_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS volunteer_submissions (
  id uuid PRIMARY KEY,
  slack_submission_id text NOT NULL,
  volunteer_slack_user_id text NOT NULL
    REFERENCES volunteer_profiles (slack_user_id) ON UPDATE CASCADE,
  -- Who typed the request in. It equals volunteer_slack_user_id when the
  -- volunteer submitted it themselves, and differs when an admin entered the
  -- hours on the volunteer's behalf.
  submitted_by_slack_user_id text NOT NULL,
  category_id uuid NOT NULL REFERENCES volunteer_categories (id),
  event_id uuid REFERENCES volunteer_events (id),
  description text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  decided_by_slack_user_id text,
  decided_at timestamptz,
  decision_note text,
  approval_channel_id text,
  approval_message_ts text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  -- Set when the request was changed after it was submitted.
  edited_by_slack_user_id text,
  edited_at timestamptz,
  -- Bumped by every edit. The Approve and Disapprove buttons carry the version
  -- they were shown with, so a click on a card that has since been edited is
  -- refused instead of approving hours the approver never saw.
  version integer NOT NULL DEFAULT 0,

  CONSTRAINT volunteer_submissions_status CHECK (
    status IN ('pending', 'approved', 'rejected')
  ),

  CONSTRAINT volunteer_submissions_decision_consistent CHECK (
    (
      status = 'pending'
      AND decided_by_slack_user_id IS NULL
      AND decided_at IS NULL
    )
    OR (
      status IN ('approved', 'rejected')
      AND decided_by_slack_user_id IS NOT NULL
      AND decided_at IS NOT NULL
    )
  ),

  CONSTRAINT volunteer_submissions_rejection_note CHECK (
    status <> 'rejected'
    OR NULLIF(BTRIM(decision_note), '') IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS volunteer_submissions_slack_submission_id_idx
  ON volunteer_submissions (slack_submission_id);

CREATE INDEX IF NOT EXISTS volunteer_submissions_status_idx
  ON volunteer_submissions (status);

CREATE INDEX IF NOT EXISTS volunteer_submissions_volunteer_idx
  ON volunteer_submissions (volunteer_slack_user_id);

CREATE TABLE IF NOT EXISTS volunteer_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL
    REFERENCES volunteer_submissions (id) ON DELETE CASCADE,
  year_id uuid NOT NULL REFERENCES volunteer_years (id),
  entry_date date NOT NULL,
  hours numeric(4, 2) NOT NULL,
  ccr_sent_at timestamptz,
  ccr_export_id uuid REFERENCES volunteer_report_exports (id)
    ON DELETE SET NULL,

  CONSTRAINT volunteer_entries_hours_range CHECK (hours > 0 AND hours <= 24),

  CONSTRAINT volunteer_entries_unique_date UNIQUE (submission_id, entry_date)
);

CREATE INDEX IF NOT EXISTS volunteer_entries_entry_date_idx
  ON volunteer_entries (entry_date);

CREATE INDEX IF NOT EXISTS volunteer_entries_year_idx
  ON volunteer_entries (year_id);

CREATE TABLE IF NOT EXISTS volunteer_report_export_entries (
  export_id uuid NOT NULL
    REFERENCES volunteer_report_exports (id) ON DELETE CASCADE,
  entry_id uuid NOT NULL
    REFERENCES volunteer_entries (id) ON DELETE CASCADE,

  PRIMARY KEY (export_id, entry_id)
);

-- Every edit or deletion of submitted hours leaves a row here with the request as
-- it was before (and after, for edits). There is deliberately no foreign key:
-- the history has to outlive a request that was deleted.
CREATE TABLE IF NOT EXISTS volunteer_submission_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL,
  volunteer_slack_user_id text NOT NULL,
  changed_by_slack_user_id text NOT NULL,
  action text NOT NULL,
  before_snapshot jsonb NOT NULL,
  after_snapshot jsonb,
  changed_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT volunteer_submission_changes_action CHECK (
    action IN ('edit', 'delete')
  )
);

CREATE INDEX IF NOT EXISTS volunteer_submission_changes_submission_idx
  ON volunteer_submission_changes (submission_id);

-- Seed data. Volunteer years are deliberately not seeded: an exec creates each
-- one (for example "2026/27 Volunteer Year") from /volunteer-admin. Until one
-- exists, volunteers are told to ask an exec.
INSERT INTO volunteer_categories (name, requires_event, sort_order)
VALUES
  ('General', false, 10),
  ('Jummah', false, 20),
  ('Specific Event', true, 30)
ON CONFLICT DO NOTHING;

-- Staff are community-workspace Slack IDs. Volunteer admins (the
-- SLACK_VOLUNTEER_ADMIN_USER_IDS env var) add them from /volunteer-admin, with a
-- title that is printed under the signature on letters. Raw SQL also works:
-- INSERT INTO volunteer_staff
--   (slack_user_id, display_name, title, can_approve, can_manage, is_primary)
-- VALUES ('U0123456789', 'Zainab', 'Vice President', true, true, true);

COMMIT;
