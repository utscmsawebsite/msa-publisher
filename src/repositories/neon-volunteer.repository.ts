import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import type {
  MarkSentResult,
  ReportEntry,
  ReportExport,
  ReportExportInput,
  ReportFilters,
} from "../domain/volunteer-report.js";
import type {
  CreateSubmissionResult,
  DeleteSubmissionResult,
  PreparedSubmission,
  StudentType,
  SubmissionEdit,
  SubmissionEntry,
  SubmissionSnapshot,
  SubmissionStatus,
  UpdateSubmissionResult,
  VolunteerCategory,
  VolunteerEntryRow,
  VolunteerEvent,
  VolunteerProfile,
  VolunteerProfileInput,
  VolunteerStaffMember,
  VolunteerSubmission,
  VolunteerYear,
  YearStats,
  UpdateYearResult,
  DeleteYearResult,
} from "../domain/volunteer.js";
import type { VolunteerRepository } from "./volunteer.repository.js";

type DatabaseRow = Record<string, unknown>;

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function mapProfile(row: DatabaseRow): VolunteerProfile {
  return {
    slackUserId: String(row.slackUserId),
    studentType: String(row.studentType) as StudentType,
    firstName: String(row.firstName),
    lastName: String(row.lastName),
    fullName: String(row.fullName),
    preferredEmail: String(row.preferredEmail),
    email: String(row.email),
    utorid: nullableString(row.utorid),
    studentNumber: String(row.studentNumber),
  };
}

function mapYear(row: DatabaseRow): VolunteerYear {
  return {
    id: String(row.id),
    label: String(row.label),
    startDate: String(row.startDate),
    endDate: String(row.endDate),
  };
}

function mapCategory(row: DatabaseRow): VolunteerCategory {
  return {
    id: String(row.id),
    name: String(row.name),
    requiresEvent: Boolean(row.requiresEvent),
    isActive: Boolean(row.isActive),
    sortOrder: Number(row.sortOrder),
  };
}

function mapEvent(row: DatabaseRow): VolunteerEvent {
  return {
    id: String(row.id),
    name: String(row.name),
    eventDate: nullableString(row.eventDate),
    isActive: Boolean(row.isActive),
  };
}

function mapStaff(row: DatabaseRow): VolunteerStaffMember {
  return {
    slackUserId: String(row.slackUserId),
    displayName: nullableString(row.displayName),
    title: nullableString(row.title),
    canApprove: Boolean(row.canApprove),
    canManage: Boolean(row.canManage),
    isPrimary: Boolean(row.isPrimary),
  };
}

function mapEntry(row: DatabaseRow): SubmissionEntry {
  return {
    id: String(row.id),
    entryDate: String(row.entryDate),
    hours: Number(row.hours),
    yearId: String(row.yearId),
    ccrSentAt: nullableString(row.ccrSentAt),
  };
}

function mapSubmission(
  row: DatabaseRow,
  entries: SubmissionEntry[],
): VolunteerSubmission {
  return {
    id: String(row.id),
    slackSubmissionId: String(row.slackSubmissionId),
    volunteerSlackUserId: String(row.volunteerSlackUserId),
    submittedBySlackUserId: String(row.submittedBySlackUserId),
    volunteerName: String(row.volunteerName),
    studentType: String(row.studentType) as StudentType,
    categoryId: String(row.categoryId),
    categoryName: String(row.categoryName),
    eventId: nullableString(row.eventId),
    eventName: nullableString(row.eventName),
    description: String(row.description),
    status: String(row.status) as SubmissionStatus,
    decidedBySlackUserId: nullableString(row.decidedBySlackUserId),
    decidedAt: nullableString(row.decidedAt),
    decisionNote: nullableString(row.decisionNote),
    approvalChannelId: nullableString(row.approvalChannelId),
    approvalMessageTs: nullableString(row.approvalMessageTs),
    submittedAt: String(row.submittedAt),
    editedBySlackUserId: nullableString(row.editedBySlackUserId),
    editedAt: nullableString(row.editedAt),
    version: Number(row.version ?? 0),
    entries,
  };
}

export class NeonVolunteerRepository implements VolunteerRepository {
  private readonly sql: NeonQueryFunction<false, false>;

  // `sql` lets tests run these queries against a local Postgres.
  constructor(databaseUrl: string, sql?: NeonQueryFunction<false, false>) {
    this.sql = sql ?? neon(databaseUrl);
  }

  async getProfile(slackUserId: string): Promise<VolunteerProfile | null> {
    const rows = await this.sql`
      SELECT
        slack_user_id AS "slackUserId",
        student_type AS "studentType",
        first_name AS "firstName",
        last_name AS "lastName",
        full_name AS "fullName",
        preferred_email AS "preferredEmail",
        email,
        utorid,
        student_number AS "studentNumber"
      FROM volunteer_profiles
      WHERE slack_user_id = ${slackUserId}
      LIMIT 1
    `;

    const row = rows[0];
    return row ? mapProfile(row) : null;
  }

  async searchProfiles(
    query: string,
    limit: number,
  ): Promise<VolunteerProfile[]> {
    // Escape LIKE wildcards so a typed % or _ is matched literally.
    const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const rows = await this.sql`
      SELECT
        slack_user_id AS "slackUserId",
        student_type AS "studentType",
        first_name AS "firstName",
        last_name AS "lastName",
        full_name AS "fullName",
        preferred_email AS "preferredEmail",
        email,
        utorid,
        student_number AS "studentNumber"
      FROM volunteer_profiles
      WHERE full_name ILIKE ${pattern}
        OR utorid ILIKE ${pattern}
        OR student_number ILIKE ${pattern}
        OR email ILIKE ${pattern}
      ORDER BY full_name ASC, slack_user_id ASC
      LIMIT ${limit}
    `;

    return rows.map(mapProfile);
  }

  async findProfileByUtorid(utorid: string): Promise<VolunteerProfile | null> {
    const rows = await this.sql`
      SELECT
        slack_user_id AS "slackUserId",
        student_type AS "studentType",
        first_name AS "firstName",
        last_name AS "lastName",
        full_name AS "fullName",
        preferred_email AS "preferredEmail",
        email,
        utorid,
        student_number AS "studentNumber"
      FROM volunteer_profiles
      WHERE lower(utorid) = lower(${utorid})
      LIMIT 1
    `;

    const row = rows[0];
    return row ? mapProfile(row) : null;
  }

  async findProfileByStudentKey(
    studentType: StudentType,
    studentNumber: string,
  ): Promise<VolunteerProfile | null> {
    const rows = await this.sql`
      SELECT
        slack_user_id AS "slackUserId",
        student_type AS "studentType",
        first_name AS "firstName",
        last_name AS "lastName",
        full_name AS "fullName",
        preferred_email AS "preferredEmail",
        email,
        utorid,
        student_number AS "studentNumber"
      FROM volunteer_profiles
      WHERE student_type = ${studentType}
        AND lower(student_number) = lower(${studentNumber})
      LIMIT 1
    `;

    const row = rows[0];
    return row ? mapProfile(row) : null;
  }

  async relinkProfile(
    placeholderKey: string,
    slackUserId: string,
  ): Promise<boolean> {
    // One statement, so two people claiming the same volunteer can't both win:
    // the loser finds no placeholder row left. ON UPDATE CASCADE moves the
    // volunteer's submissions to the new key in the same statement.
    const rows = await this.sql`
      UPDATE volunteer_profiles
      SET slack_user_id = ${slackUserId}, updated_at = now()
      WHERE slack_user_id = ${placeholderKey}
        AND starts_with(slack_user_id, 'ext_')
      RETURNING slack_user_id
    `;

    return rows.length > 0;
  }

  async upsertProfile(
    slackUserId: string,
    input: VolunteerProfileInput,
  ): Promise<VolunteerProfile> {
    const rows = await this.sql`
      INSERT INTO volunteer_profiles (
        slack_user_id,
        student_type,
        first_name,
        last_name,
        preferred_email,
        email,
        utorid,
        student_number
      ) VALUES (
        ${slackUserId},
        ${input.studentType},
        ${input.firstName},
        ${input.lastName},
        ${input.preferredEmail},
        ${input.email},
        ${input.utorid},
        ${input.studentNumber}
      )
      ON CONFLICT (slack_user_id) DO UPDATE SET
        student_type = EXCLUDED.student_type,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        preferred_email = EXCLUDED.preferred_email,
        email = EXCLUDED.email,
        utorid = EXCLUDED.utorid,
        student_number = EXCLUDED.student_number,
        updated_at = now()
      RETURNING
        slack_user_id AS "slackUserId",
        student_type AS "studentType",
        first_name AS "firstName",
        last_name AS "lastName",
        full_name AS "fullName",
        preferred_email AS "preferredEmail",
        email,
        utorid,
        student_number AS "studentNumber"
    `;

    const row = rows[0];
    if (!row) {
      throw new Error("The profile upsert did not return a database record.");
    }

    return mapProfile(row);
  }

  async listCategories(): Promise<VolunteerCategory[]> {
    const rows = await this.sql`
      SELECT
        id,
        name,
        requires_event AS "requiresEvent",
        is_active AS "isActive",
        sort_order AS "sortOrder"
      FROM volunteer_categories
      ORDER BY sort_order ASC, name ASC
    `;

    return rows.map(mapCategory);
  }

  async listEvents(): Promise<VolunteerEvent[]> {
    const rows = await this.sql`
      SELECT
        id,
        name,
        event_date::text AS "eventDate",
        is_active AS "isActive"
      FROM volunteer_events
      ORDER BY event_date DESC NULLS LAST, created_at DESC
      LIMIT 200
    `;

    return rows.map(mapEvent);
  }

  async listYears(): Promise<VolunteerYear[]> {
    const rows = await this.sql`
      SELECT
        id,
        label,
        start_date::text AS "startDate",
        end_date::text AS "endDate"
      FROM volunteer_years
      ORDER BY start_date ASC
    `;

    return rows.map(mapYear);
  }

  async getStaffMember(
    slackUserId: string,
  ): Promise<VolunteerStaffMember | null> {
    const rows = await this.sql`
      SELECT
        slack_user_id AS "slackUserId",
        display_name AS "displayName",
        title,
        can_approve AS "canApprove",
        can_manage AS "canManage",
        is_primary AS "isPrimary"
      FROM volunteer_staff
      WHERE slack_user_id = ${slackUserId}
      LIMIT 1
    `;

    const row = rows[0];
    return row ? mapStaff(row) : null;
  }

  async getPrimaryApprover(): Promise<VolunteerStaffMember | null> {
    const rows = await this.sql`
      SELECT
        slack_user_id AS "slackUserId",
        display_name AS "displayName",
        title,
        can_approve AS "canApprove",
        can_manage AS "canManage",
        is_primary AS "isPrimary"
      FROM volunteer_staff
      WHERE is_primary
      LIMIT 1
    `;

    const row = rows[0];
    return row ? mapStaff(row) : null;
  }

  async sumHoursByDate(
    slackUserId: string,
    dates: string[],
    excludeSubmissionId?: string,
  ): Promise<Map<string, number>> {
    const totals = new Map<string, number>();

    if (dates.length === 0) {
      return totals;
    }

    const rows = await this.sql`
      SELECT
        e.entry_date::text AS "entryDate",
        SUM(e.hours)::text AS "hours"
      FROM volunteer_entries e
      JOIN volunteer_submissions s ON s.id = e.submission_id
      WHERE s.volunteer_slack_user_id = ${slackUserId}
        AND s.status IN ('pending', 'approved')
        AND e.entry_date = ANY(${dates}::date[])
        AND (${excludeSubmissionId ?? null}::uuid IS NULL
          OR s.id <> ${excludeSubmissionId ?? null}::uuid)
      GROUP BY e.entry_date
    `;

    for (const row of rows) {
      totals.set(String(row.entryDate), Number(row.hours));
    }

    return totals;
  }

  async createSubmission(
    submission: PreparedSubmission,
  ): Promise<CreateSubmissionResult> {
    const yearIds = submission.entries.map((entry) => entry.yearId);
    const entryDates = submission.entries.map((entry) => entry.entryDate);
    const hours = submission.entries.map((entry) => String(entry.hours));

    // One statement keeps the submission and its entries atomic. A duplicate
    // slack_submission_id inserts nothing and falls through to the re-read.
    await this.sql`
      WITH inserted AS (
        INSERT INTO volunteer_submissions (
          id,
          slack_submission_id,
          volunteer_slack_user_id,
          submitted_by_slack_user_id,
          category_id,
          event_id,
          description,
          status,
          decided_by_slack_user_id,
          decided_at
        ) VALUES (
          ${submission.id},
          ${submission.slackSubmissionId},
          ${submission.volunteerSlackUserId},
          ${submission.submittedBySlackUserId},
          ${submission.categoryId},
          ${submission.eventId},
          ${submission.description},
          CASE WHEN ${submission.approvedBySlackUserId}::text IS NULL
            THEN 'pending' ELSE 'approved' END,
          ${submission.approvedBySlackUserId}::text,
          CASE WHEN ${submission.approvedBySlackUserId}::text IS NULL
            THEN NULL ELSE now() END
        )
        ON CONFLICT (slack_submission_id) DO NOTHING
        RETURNING id
      )
      INSERT INTO volunteer_entries (submission_id, year_id, entry_date, hours)
      SELECT inserted.id, e.year_id, e.entry_date, e.hours
      FROM inserted,
        unnest(
          ${yearIds}::uuid[],
          ${entryDates}::date[],
          ${hours}::numeric[]
        ) AS e(year_id, entry_date, hours)
    `;

    const saved = await this.getSubmissionBySlackId(
      submission.slackSubmissionId,
    );

    if (!saved) {
      throw new Error("The submission insert did not return a database record.");
    }

    return { submission: saved, created: saved.id === submission.id };
  }

  async getSubmission(id: string): Promise<VolunteerSubmission | null> {
    const rows = await this.sql`
      SELECT
        s.id,
        s.slack_submission_id AS "slackSubmissionId",
        s.volunteer_slack_user_id AS "volunteerSlackUserId",
        s.submitted_by_slack_user_id AS "submittedBySlackUserId",
        p.full_name AS "volunteerName",
        p.student_type AS "studentType",
        s.category_id AS "categoryId",
        c.name AS "categoryName",
        s.event_id AS "eventId",
        ev.name AS "eventName",
        s.description,
        s.status,
        s.decided_by_slack_user_id AS "decidedBySlackUserId",
        s.decided_at::text AS "decidedAt",
        s.decision_note AS "decisionNote",
        s.approval_channel_id AS "approvalChannelId",
        s.approval_message_ts AS "approvalMessageTs",
        s.submitted_at::text AS "submittedAt",
        s.edited_by_slack_user_id AS "editedBySlackUserId",
        s.edited_at::text AS "editedAt",
        s.version
      FROM volunteer_submissions s
      JOIN volunteer_profiles p ON p.slack_user_id = s.volunteer_slack_user_id
      JOIN volunteer_categories c ON c.id = s.category_id
      LEFT JOIN volunteer_events ev ON ev.id = s.event_id
      WHERE s.id = ${id}
      LIMIT 1
    `;

    const row = rows[0];
    return row ? this.withEntries(row) : null;
  }

  private async getSubmissionBySlackId(
    slackSubmissionId: string,
  ): Promise<VolunteerSubmission | null> {
    const rows = await this.sql`
      SELECT
        s.id,
        s.slack_submission_id AS "slackSubmissionId",
        s.volunteer_slack_user_id AS "volunteerSlackUserId",
        s.submitted_by_slack_user_id AS "submittedBySlackUserId",
        p.full_name AS "volunteerName",
        p.student_type AS "studentType",
        s.category_id AS "categoryId",
        c.name AS "categoryName",
        s.event_id AS "eventId",
        ev.name AS "eventName",
        s.description,
        s.status,
        s.decided_by_slack_user_id AS "decidedBySlackUserId",
        s.decided_at::text AS "decidedAt",
        s.decision_note AS "decisionNote",
        s.approval_channel_id AS "approvalChannelId",
        s.approval_message_ts AS "approvalMessageTs",
        s.submitted_at::text AS "submittedAt",
        s.edited_by_slack_user_id AS "editedBySlackUserId",
        s.edited_at::text AS "editedAt",
        s.version
      FROM volunteer_submissions s
      JOIN volunteer_profiles p ON p.slack_user_id = s.volunteer_slack_user_id
      JOIN volunteer_categories c ON c.id = s.category_id
      LEFT JOIN volunteer_events ev ON ev.id = s.event_id
      WHERE s.slack_submission_id = ${slackSubmissionId}
      LIMIT 1
    `;

    const row = rows[0];
    return row ? this.withEntries(row) : null;
  }

  private async withEntries(row: DatabaseRow): Promise<VolunteerSubmission> {
    const entryRows = await this.sql`
      SELECT
        id,
        entry_date::text AS "entryDate",
        hours::text AS "hours",
        year_id AS "yearId",
        ccr_sent_at::text AS "ccrSentAt"
      FROM volunteer_entries
      WHERE submission_id = ${String(row.id)}
      ORDER BY entry_date ASC
    `;

    return mapSubmission(row, entryRows.map(mapEntry));
  }

  async setApprovalMessage(
    id: string,
    channelId: string,
    messageTs: string,
  ): Promise<void> {
    await this.sql`
      UPDATE volunteer_submissions
      SET approval_channel_id = ${channelId},
          approval_message_ts = ${messageTs}
      WHERE id = ${id}
    `;
  }

  async listSubmissionsForVolunteer(
    slackUserId: string,
    limit: number,
  ): Promise<VolunteerSubmission[]> {
    const rows = await this.sql`
      SELECT
        s.id,
        s.slack_submission_id AS "slackSubmissionId",
        s.volunteer_slack_user_id AS "volunteerSlackUserId",
        s.submitted_by_slack_user_id AS "submittedBySlackUserId",
        p.full_name AS "volunteerName",
        p.student_type AS "studentType",
        s.category_id AS "categoryId",
        c.name AS "categoryName",
        s.event_id AS "eventId",
        ev.name AS "eventName",
        s.description,
        s.status,
        s.decided_by_slack_user_id AS "decidedBySlackUserId",
        s.decided_at::text AS "decidedAt",
        s.decision_note AS "decisionNote",
        s.approval_channel_id AS "approvalChannelId",
        s.approval_message_ts AS "approvalMessageTs",
        s.submitted_at::text AS "submittedAt",
        s.edited_by_slack_user_id AS "editedBySlackUserId",
        s.edited_at::text AS "editedAt",
        s.version
      FROM volunteer_submissions s
      JOIN volunteer_profiles p ON p.slack_user_id = s.volunteer_slack_user_id
      JOIN volunteer_categories c ON c.id = s.category_id
      LEFT JOIN volunteer_events ev ON ev.id = s.event_id
      WHERE s.volunteer_slack_user_id = ${slackUserId}
      ORDER BY s.submitted_at DESC
      LIMIT ${limit}
    `;

    return Promise.all(rows.map((row) => this.withEntries(row)));
  }

  async listPendingSubmissions(
    limit: number,
  ): Promise<VolunteerSubmission[]> {
    const rows = await this.sql`
      SELECT
        s.id,
        s.slack_submission_id AS "slackSubmissionId",
        s.volunteer_slack_user_id AS "volunteerSlackUserId",
        s.submitted_by_slack_user_id AS "submittedBySlackUserId",
        p.full_name AS "volunteerName",
        p.student_type AS "studentType",
        s.category_id AS "categoryId",
        c.name AS "categoryName",
        s.event_id AS "eventId",
        ev.name AS "eventName",
        s.description,
        s.status,
        s.decided_by_slack_user_id AS "decidedBySlackUserId",
        s.decided_at::text AS "decidedAt",
        s.decision_note AS "decisionNote",
        s.approval_channel_id AS "approvalChannelId",
        s.approval_message_ts AS "approvalMessageTs",
        s.submitted_at::text AS "submittedAt",
        s.edited_by_slack_user_id AS "editedBySlackUserId",
        s.edited_at::text AS "editedAt",
        s.version
      FROM volunteer_submissions s
      JOIN volunteer_profiles p ON p.slack_user_id = s.volunteer_slack_user_id
      JOIN volunteer_categories c ON c.id = s.category_id
      LEFT JOIN volunteer_events ev ON ev.id = s.event_id
      WHERE s.status = 'pending'
      ORDER BY s.submitted_at ASC
      LIMIT ${limit}
    `;

    return Promise.all(rows.map((row) => this.withEntries(row)));
  }

  async countPendingSubmissions(): Promise<number> {
    const rows = await this.sql`
      SELECT count(*)::int AS "total"
      FROM volunteer_submissions
      WHERE status = 'pending'
    `;

    return Number(rows[0]?.total ?? 0);
  }

  async updateSubmission(
    edit: SubmissionEdit,
    audit: { before: SubmissionSnapshot; after: SubmissionSnapshot },
  ): Promise<UpdateSubmissionResult> {
    const yearIds = edit.entries.map((entry) => entry.yearId);
    const entryDates = edit.entries.map((entry) => entry.entryDate);
    const hours = edit.entries.map((entry) => String(entry.hours));

    // One statement, so the request, its dates and the audit row change
    // together or not at all. It does nothing if any of the request's hours
    // were already sent to CCR. Dates that stay keep their entry row (and so
    // their report history); only the hours change.
    const result = await this.sql`
      WITH target AS (
        SELECT s.id, s.volunteer_slack_user_id
        FROM volunteer_submissions s
        WHERE s.id = ${edit.submissionId}
          AND NOT EXISTS (
            SELECT 1 FROM volunteer_entries e
            WHERE e.submission_id = s.id AND e.ccr_sent_at IS NOT NULL
          )
      ),
      new_rows AS (
        SELECT * FROM unnest(
          ${yearIds}::uuid[],
          ${entryDates}::date[],
          ${hours}::numeric[]
        ) AS n(year_id, entry_date, hours)
      ),
      updated AS (
        UPDATE volunteer_submissions s
        SET category_id = ${edit.categoryId},
            event_id = ${edit.eventId},
            description = ${edit.description},
            status = CASE WHEN ${edit.approvedBySlackUserId}::text IS NULL
              THEN 'pending' ELSE 'approved' END,
            decided_by_slack_user_id = ${edit.approvedBySlackUserId}::text,
            decided_at = CASE WHEN ${edit.approvedBySlackUserId}::text IS NULL
              THEN NULL ELSE now() END,
            decision_note = NULL,
            edited_by_slack_user_id = ${edit.editedBySlackUserId},
            edited_at = now(),
            version = s.version + 1
        FROM target t
        WHERE s.id = t.id
        RETURNING s.id, t.volunteer_slack_user_id
      ),
      removed AS (
        DELETE FROM volunteer_entries e
        USING updated u
        WHERE e.submission_id = u.id
          AND NOT EXISTS (
            SELECT 1 FROM new_rows n WHERE n.entry_date = e.entry_date
          )
        RETURNING e.id
      ),
      changed AS (
        UPDATE volunteer_entries e
        SET hours = n.hours, year_id = n.year_id
        FROM new_rows n, updated u
        WHERE e.submission_id = u.id AND e.entry_date = n.entry_date
        RETURNING e.id
      ),
      audited AS (
        INSERT INTO volunteer_submission_changes (
          submission_id,
          volunteer_slack_user_id,
          changed_by_slack_user_id,
          action,
          before_snapshot,
          after_snapshot
        )
        SELECT
          u.id,
          u.volunteer_slack_user_id,
          ${edit.editedBySlackUserId},
          'edit',
          ${JSON.stringify(audit.before)}::jsonb,
          ${JSON.stringify(audit.after)}::jsonb
        FROM updated u
        RETURNING id
      ),
      added AS (
        INSERT INTO volunteer_entries (submission_id, year_id, entry_date, hours)
        SELECT u.id, n.year_id, n.entry_date, n.hours
        FROM updated u, new_rows n
        WHERE NOT EXISTS (
          SELECT 1 FROM volunteer_entries e
          WHERE e.submission_id = u.id AND e.entry_date = n.entry_date
        )
        RETURNING id
      )
      SELECT count(*)::int AS "updatedCount" FROM updated
    `;

    if (Number(result[0]?.updatedCount ?? 0) > 0) {
      const saved = await this.getSubmission(edit.submissionId);

      if (saved) {
        return { status: "ok", submission: saved };
      }
    }

    // Nothing changed: the request is gone, or locked by hours sent to CCR.
    return (await this.getSubmission(edit.submissionId))
      ? { status: "locked" }
      : { status: "not_found" };
  }

  async deleteSubmission(
    id: string,
    deletedBySlackUserId: string,
    before: SubmissionSnapshot,
  ): Promise<DeleteSubmissionResult> {
    // The audit row and the delete are one statement; a request with hours
    // already sent to CCR is left alone.
    const rows = await this.sql`
      WITH target AS (
        SELECT s.id, s.volunteer_slack_user_id
        FROM volunteer_submissions s
        WHERE s.id = ${id}
          AND NOT EXISTS (
            SELECT 1 FROM volunteer_entries e
            WHERE e.submission_id = s.id AND e.ccr_sent_at IS NOT NULL
          )
      ),
      audited AS (
        INSERT INTO volunteer_submission_changes (
          submission_id,
          volunteer_slack_user_id,
          changed_by_slack_user_id,
          action,
          before_snapshot
        )
        SELECT
          t.id,
          t.volunteer_slack_user_id,
          ${deletedBySlackUserId},
          'delete',
          ${JSON.stringify(before)}::jsonb
        FROM target t
        RETURNING id
      )
      DELETE FROM volunteer_submissions s
      USING target t
      WHERE s.id = t.id
      RETURNING s.id
    `;

    if (rows.length > 0) {
      return { status: "ok" };
    }

    return (await this.getSubmission(id)) ? { status: "locked" } : { status: "not_found" };
  }

  async decideSubmission(
    id: string,
    decision: "approved" | "rejected",
    decidedBySlackUserId: string,
    note: string | null,
    expectedVersion?: number,
  ): Promise<VolunteerSubmission | null> {
    const rows = await this.sql`
      UPDATE volunteer_submissions
      SET status = ${decision},
          decided_by_slack_user_id = ${decidedBySlackUserId},
          decided_at = now(),
          decision_note = ${note}
      WHERE id = ${id}
        AND status = 'pending'
        AND (${expectedVersion ?? null}::int IS NULL
          OR version = ${expectedVersion ?? null}::int)
      RETURNING id
    `;

    if (!rows[0]) {
      return null;
    }

    return this.getSubmission(id);
  }

  async listEntriesForVolunteer(
    slackUserId: string,
    limit: number,
  ): Promise<VolunteerEntryRow[]> {
    const rows = await this.sql`
      SELECT
        e.entry_date::text AS "entryDate",
        e.hours::text AS "hours",
        s.status,
        c.name AS "categoryName",
        ev.name AS "eventName",
        s.description,
        s.decision_note AS "decisionNote",
        (s.submitted_by_slack_user_id <> s.volunteer_slack_user_id) AS "enteredByStaff"
      FROM volunteer_entries e
      JOIN volunteer_submissions s ON s.id = e.submission_id
      JOIN volunteer_categories c ON c.id = s.category_id
      LEFT JOIN volunteer_events ev ON ev.id = s.event_id
      WHERE s.volunteer_slack_user_id = ${slackUserId}
      ORDER BY e.entry_date DESC, s.submitted_at DESC
      LIMIT ${limit}
    `;

    return rows.map((row) => ({
      entryDate: String(row.entryDate),
      hours: Number(row.hours),
      status: String(row.status) as SubmissionStatus,
      categoryName: String(row.categoryName),
      eventName: nullableString(row.eventName),
      description: String(row.description),
      decisionNote: nullableString(row.decisionNote),
      enteredByStaff: Boolean(row.enteredByStaff),
    }));
  }

  async listReportEntries(filters: ReportFilters): Promise<ReportEntry[]> {
    const studentType =
      filters.studentType === "all" ? null : filters.studentType;
    const userIds = filters.volunteerSlackUserIds;

    const rows = await this.sql`
      SELECT
        e.id AS "entryId",
        e.entry_date::text AS "entryDate",
        e.hours::text AS "hours",
        s.description,
        c.name AS "categoryName",
        ev.name AS "eventName",
        e.ccr_sent_at::text AS "ccrSentAt",
        p.slack_user_id AS "volunteerSlackUserId",
        p.full_name AS "fullName",
        p.email,
        p.student_type AS "studentType",
        p.utorid,
        p.student_number AS "studentNumber",
        y.label AS "yearLabel"
      FROM volunteer_entries e
      JOIN volunteer_submissions s ON s.id = e.submission_id
      JOIN volunteer_profiles p ON p.slack_user_id = s.volunteer_slack_user_id
      JOIN volunteer_categories c ON c.id = s.category_id
      LEFT JOIN volunteer_events ev ON ev.id = s.event_id
      JOIN volunteer_years y ON y.id = e.year_id
      WHERE s.status = 'approved'
        AND e.year_id = ${filters.yearId}
        AND (${studentType}::text IS NULL OR p.student_type = ${studentType})
        AND (NOT ${filters.onlyUnsent}::boolean OR e.ccr_sent_at IS NULL)
        AND (
          ${userIds}::text[] IS NULL
          OR p.slack_user_id = ANY(${userIds}::text[])
        )
      ORDER BY e.entry_date ASC
    `;

    return rows.map((row) => ({
      entryId: String(row.entryId),
      entryDate: String(row.entryDate),
      hours: Number(row.hours),
      description: String(row.description),
      categoryName: String(row.categoryName),
      eventName: nullableString(row.eventName),
      ccrSentAt: nullableString(row.ccrSentAt),
      volunteerSlackUserId: String(row.volunteerSlackUserId),
      fullName: String(row.fullName),
      email: String(row.email),
      studentType: String(row.studentType) as StudentType,
      utorid: nullableString(row.utorid),
      studentNumber: String(row.studentNumber),
      yearLabel: String(row.yearLabel),
    }));
  }

  async createExport(input: ReportExportInput): Promise<ReportExport> {
    const id = randomUUID();

    await this.sql`
      WITH created AS (
        INSERT INTO volunteer_report_exports (
          id,
          generated_by_slack_user_id,
          year_id,
          kind,
          filters,
          entry_count,
          total_hours
        ) VALUES (
          ${id},
          ${input.generatedBySlackUserId},
          ${input.yearId},
          ${input.kind},
          ${JSON.stringify(input.filters)}::jsonb,
          ${input.entryIds.length},
          ${input.totalHours}
        )
        RETURNING id
      )
      INSERT INTO volunteer_report_export_entries (export_id, entry_id)
      SELECT created.id, entry_id
      FROM created, unnest(${input.entryIds}::uuid[]) AS entry_id
    `;

    const created = await this.getExport(id);

    if (!created) {
      throw new Error("The export insert did not return a database record.");
    }

    return created;
  }

  async getExport(id: string): Promise<ReportExport | null> {
    const rows = await this.sql`
      SELECT
        id,
        generated_by_slack_user_id AS "generatedBySlackUserId",
        year_id AS "yearId",
        kind,
        entry_count AS "entryCount",
        total_hours::text AS "totalHours",
        generated_at::text AS "generatedAt",
        marked_sent_at::text AS "markedSentAt",
        marked_sent_by_slack_user_id AS "markedSentBySlackUserId"
      FROM volunteer_report_exports
      WHERE id = ${id}
      LIMIT 1
    `;

    const row = rows[0];

    return row
      ? {
          id: String(row.id),
          generatedBySlackUserId: String(row.generatedBySlackUserId),
          yearId: String(row.yearId),
          kind: String(row.kind) as ReportExport["kind"],
          entryCount: Number(row.entryCount),
          totalHours: Number(row.totalHours),
          generatedAt: String(row.generatedAt),
          markedSentAt: nullableString(row.markedSentAt),
          markedSentBySlackUserId: nullableString(row.markedSentBySlackUserId),
        }
      : null;
  }

  async markExportSent(
    id: string,
    markedBySlackUserId: string,
  ): Promise<MarkSentResult> {
    const rows = await this.sql`
      WITH marked AS (
        UPDATE volunteer_report_exports
        SET marked_sent_at = now(),
            marked_sent_by_slack_user_id = ${markedBySlackUserId}
        WHERE id = ${id} AND marked_sent_at IS NULL
        RETURNING id
      ), updated AS (
        UPDATE volunteer_entries
        SET ccr_sent_at = now(),
            ccr_export_id = ${id}
        WHERE ccr_sent_at IS NULL
          AND EXISTS (SELECT 1 FROM marked)
          AND id IN (
            SELECT entry_id
            FROM volunteer_report_export_entries
            WHERE export_id = ${id}
          )
        RETURNING id
      )
      SELECT
        (SELECT count(*) FROM marked)::int AS "markedExports",
        (SELECT count(*) FROM updated)::int AS "markedEntries"
    `;

    const row = rows[0];

    if (Number(row?.markedExports ?? 0) > 0) {
      return { status: "ok", markedEntries: Number(row?.markedEntries ?? 0) };
    }

    const existing = await this.getExport(id);

    return {
      status: existing ? "already_marked" : "not_found",
      markedEntries: 0,
    };
  }

  async listStaff(): Promise<VolunteerStaffMember[]> {
    const rows = await this.sql`
      SELECT
        slack_user_id AS "slackUserId",
        display_name AS "displayName",
        title,
        can_approve AS "canApprove",
        can_manage AS "canManage",
        is_primary AS "isPrimary"
      FROM volunteer_staff
      ORDER BY is_primary DESC, display_name ASC NULLS LAST, slack_user_id ASC
    `;

    return rows.map(mapStaff);
  }

  async upsertStaffMember(
    member: VolunteerStaffMember,
    addedBySlackUserId: string,
  ): Promise<void> {
    const upsert = this.sql`
      INSERT INTO volunteer_staff (
        slack_user_id,
        display_name,
        title,
        can_approve,
        can_manage,
        is_primary,
        added_by_slack_user_id
      ) VALUES (
        ${member.slackUserId},
        ${member.displayName},
        ${member.title},
        ${member.canApprove},
        ${member.canManage},
        ${member.isPrimary},
        ${addedBySlackUserId}
      )
      ON CONFLICT (slack_user_id) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, volunteer_staff.display_name),
        title = EXCLUDED.title,
        can_approve = EXCLUDED.can_approve,
        can_manage = EXCLUDED.can_manage,
        is_primary = EXCLUDED.is_primary
    `;

    if (member.isPrimary) {
      // The unique index allows one primary, so the old one is cleared in the
      // same transaction before the new one is written.
      await this.sql.transaction([
        this.sql`
          UPDATE volunteer_staff
          SET is_primary = false
          WHERE is_primary AND slack_user_id <> ${member.slackUserId}
        `,
        upsert,
      ]);
      return;
    }

    await upsert;
  }

  async removeStaffMember(slackUserId: string): Promise<boolean> {
    const rows = await this.sql`
      DELETE FROM volunteer_staff
      WHERE slack_user_id = ${slackUserId}
      RETURNING slack_user_id
    `;

    return rows.length > 0;
  }

  async createCategory(
    name: string,
    requiresEvent: boolean,
  ): Promise<VolunteerCategory> {
    const rows = await this.sql`
      INSERT INTO volunteer_categories (name, requires_event, sort_order)
      VALUES (
        ${name},
        ${requiresEvent},
        (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM volunteer_categories)
      )
      RETURNING
        id,
        name,
        requires_event AS "requiresEvent",
        is_active AS "isActive",
        sort_order AS "sortOrder"
    `;

    const row = rows[0];
    if (!row) {
      throw new Error("The category insert did not return a database record.");
    }

    return mapCategory(row);
  }

  async updateCategory(
    id: string,
    changes: { name?: string; isActive?: boolean },
  ): Promise<VolunteerCategory | null> {
    const rows = await this.sql`
      UPDATE volunteer_categories
      SET name = COALESCE(${changes.name ?? null}, name),
          is_active = COALESCE(${changes.isActive ?? null}::boolean, is_active)
      WHERE id = ${id}
      RETURNING
        id,
        name,
        requires_event AS "requiresEvent",
        is_active AS "isActive",
        sort_order AS "sortOrder"
    `;

    const row = rows[0];
    return row ? mapCategory(row) : null;
  }

  async createEvent(
    name: string,
    eventDate: string | null,
    createdBySlackUserId: string,
  ): Promise<VolunteerEvent> {
    const rows = await this.sql`
      INSERT INTO volunteer_events (name, event_date, created_by_slack_user_id)
      VALUES (${name}, ${eventDate}, ${createdBySlackUserId})
      RETURNING
        id,
        name,
        event_date::text AS "eventDate",
        is_active AS "isActive"
    `;

    const row = rows[0];
    if (!row) {
      throw new Error("The event insert did not return a database record.");
    }

    return mapEvent(row);
  }

  async setEventActive(id: string, isActive: boolean): Promise<boolean> {
    const rows = await this.sql`
      UPDATE volunteer_events
      SET is_active = ${isActive}
      WHERE id = ${id}
      RETURNING id
    `;

    return rows.length > 0;
  }

  async createYear(
    label: string,
    startDate: string,
    endDate: string,
  ): Promise<VolunteerYear> {
    const rows = await this.sql`
      INSERT INTO volunteer_years (label, start_date, end_date)
      VALUES (${label}, ${startDate}, ${endDate})
      RETURNING
        id,
        label,
        start_date::text AS "startDate",
        end_date::text AS "endDate"
    `;

    const row = rows[0];
    if (!row) {
      throw new Error("The year insert did not return a database record.");
    }

    return mapYear(row);
  }

  async listYearStats(): Promise<YearStats[]> {
    const rows = await this.sql`
      SELECT
        e.year_id AS "yearId",
        count(DISTINCT s.volunteer_slack_user_id)::int AS "volunteers",
        coalesce(sum(e.hours) FILTER (WHERE s.status = 'approved'), 0) AS "approvedHours",
        coalesce(sum(e.hours) FILTER (WHERE s.status = 'pending'), 0) AS "pendingHours",
        coalesce(sum(e.hours) FILTER (WHERE s.status = 'rejected'), 0) AS "rejectedHours",
        coalesce(
          sum(e.hours) FILTER (WHERE s.status = 'approved' AND e.ccr_sent_at IS NOT NULL),
          0
        ) AS "sentHours"
      FROM volunteer_entries e
      JOIN volunteer_submissions s ON s.id = e.submission_id
      GROUP BY e.year_id
    `;

    return rows.map((row) => ({
      yearId: String(row.yearId),
      volunteers: Number(row.volunteers),
      approvedHours: Number(row.approvedHours),
      pendingHours: Number(row.pendingHours),
      rejectedHours: Number(row.rejectedHours),
      sentHours: Number(row.sentHours),
    }));
  }

  async updateYear(
    id: string,
    label: string,
    startDate: string,
    endDate: string,
  ): Promise<UpdateYearResult> {
    // The guard is part of the UPDATE itself, so a date can't be logged
    // outside the new range between a check and the change.
    const updated = await this.sql`
      UPDATE volunteer_years AS y
      SET label = ${label}, start_date = ${startDate}::date, end_date = ${endDate}::date
      WHERE y.id = ${id}
        AND NOT EXISTS (
          SELECT 1
          FROM volunteer_entries e
          WHERE e.year_id = y.id
            AND (e.entry_date < ${startDate}::date OR e.entry_date > ${endDate}::date)
        )
      RETURNING
        y.id,
        y.label,
        y.start_date::text AS "startDate",
        y.end_date::text AS "endDate"
    `;
    const row = updated[0];

    if (row) {
      return { status: "updated", year: mapYear(row) };
    }

    const diagnosis = await this.sql`
      SELECT
        EXISTS (SELECT 1 FROM volunteer_years WHERE id = ${id}) AS "found",
        (
          SELECT count(*)::int
          FROM volunteer_entries
          WHERE year_id = ${id}
            AND (entry_date < ${startDate}::date OR entry_date > ${endDate}::date)
        ) AS "outside"
    `;

    return diagnosis[0]?.found
      ? { status: "entries_outside", count: Number(diagnosis[0].outside) }
      : { status: "not_found" };
  }

  async deleteYear(id: string): Promise<DeleteYearResult> {
    const deleted = await this.sql`
      DELETE FROM volunteer_years y
      WHERE y.id = ${id}
        AND NOT EXISTS (SELECT 1 FROM volunteer_entries e WHERE e.year_id = y.id)
        AND NOT EXISTS (SELECT 1 FROM volunteer_report_exports x WHERE x.year_id = y.id)
      RETURNING y.id
    `;

    if (deleted.length > 0) {
      return "deleted";
    }

    const found = await this.sql`
      SELECT 1 AS "found" FROM volunteer_years WHERE id = ${id}
    `;

    return found.length > 0 ? "in_use" : "not_found";
  }

  async updateEvent(
    id: string,
    name: string,
    eventDate: string | null,
  ): Promise<VolunteerEvent | null> {
    const rows = await this.sql`
      UPDATE volunteer_events
      SET name = ${name}, event_date = ${eventDate}
      WHERE id = ${id}
      RETURNING
        id,
        name,
        event_date::text AS "eventDate",
        is_active AS "isActive"
    `;
    const row = rows[0];

    return row ? mapEvent(row) : null;
  }
}
