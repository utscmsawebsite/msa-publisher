import { randomUUID } from "node:crypto";
import {
  EXTERNAL_VOLUNTEER_PREFIX,
  hasSlackAccount,
  type CreateSubmissionResult,
  type EntryInput,
  type SubmissionEdit,
  type SubmissionSnapshot,
  type PreparedSubmission,
  type ProfileIssue,
  type StudentType,
  type SubmissionIssue,
  type VolunteerCategory,
  type VolunteerEntryRow,
  type VolunteerEvent,
  type VolunteerProfile,
  type VolunteerProfileInput,
  type VolunteerStaffMember,
  type VolunteerSubmission,
  type VolunteerYear,
} from "../domain/volunteer.js";
import type { VolunteerRepository } from "../repositories/volunteer.repository.js";

export const MAX_ENTRIES_PER_SUBMISSION = 15;
export const MAX_HOURS_PER_DAY = 24;
export const MAX_DESCRIPTION_LENGTH = 1500;

const CATALOG_TTL_MS = 30_000;
/** How many waiting requests the approvers' queue shows at once. */
export const PENDING_QUEUE_PAGE = 25;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const utoridPattern = /^[a-z0-9]{3,16}$/;
const uoftStudentNumberPattern = /^\d{9,10}$/;
// Other universities and high schools number their students in their own way.
const otherStudentNumberPattern = /^[A-Z0-9][A-Z0-9-]{3,19}$/;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

export interface VolunteerFormData {
  categories: VolunteerCategory[];
  events: VolunteerEvent[];
  years: VolunteerYear[];
}

export interface ProfileFormInput {
  studentType: StudentType;
  firstName: string;
  lastName: string;
  preferredEmail: string;
  email: string;
  utorid: string;
  studentNumber: string;
}

export type SaveProfileResult =
  | {
      ok: true;
      profile: VolunteerProfile;
      /** Set when this Slack user was matched to a record an exec added earlier. */
      linkedFrom: string | null;
    }
  | { ok: false; issues: ProfileIssue[] };

export interface SubmissionInput {
  slackSubmissionId: string;
  volunteerSlackUserId: string;
  /** Who typed it in. Defaults to the volunteer; differs for admin entries. */
  submittedBySlackUserId?: string;
  /**
   * Set when this is an edit of an existing request rather than a new one. The
   * request's own hours then don't count against the 24 hour daily cap.
   */
  editingSubmissionId?: string;
  categoryId: string;
  eventId: string | null;
  description: string;
  entries: EntryInput[];
}

export type PrepareSubmissionResult =
  | { ok: true; prepared: PreparedSubmission }
  | { ok: false; issues: SubmissionIssue[] };

export interface DecideInput {
  submissionId: string;
  decidedBySlackUserId: string;
  decision: "approved" | "rejected";
  note: string | null;
  /** The version the approver's card showed; a stale click is refused. */
  expectedVersion?: number;
}

export type DecisionResult =
  | { status: "ok"; submission: VolunteerSubmission }
  | { status: "not_authorized" }
  | { status: "not_found" }
  | { status: "note_required" }
  | { status: "already_decided"; submission: VolunteerSubmission }
  // The request was edited after the card the approver clicked was shown.
  | { status: "stale"; submission: VolunteerSubmission };

export type EditAccess =
  | { status: "ok"; submission: VolunteerSubmission; asExec: boolean }
  | { status: "not_found" }
  | { status: "not_allowed" }
  | { status: "locked" };

export type EditOutcome =
  | {
      status: "ok";
      before: VolunteerSubmission;
      submission: VolunteerSubmission;
      /** True when the edit went back to the approvers. */
      needsApproval: boolean;
    }
  | { status: "unchanged"; submission: VolunteerSubmission }
  | { status: "not_found" }
  | { status: "not_allowed" }
  | { status: "locked" };

export type DeleteOutcome =
  | { status: "ok"; submission: VolunteerSubmission }
  | { status: "not_found" }
  | { status: "not_allowed" }
  | { status: "locked" };

export function snapshotOf(submission: VolunteerSubmission): SubmissionSnapshot {
  return {
    categoryId: submission.categoryId,
    eventId: submission.eventId,
    description: submission.description,
    status: submission.status,
    entries: submission.entries.map((entry) => ({
      entryDate: entry.entryDate,
      hours: entry.hours,
    })),
  };
}

export interface MyHours {
  rows: VolunteerEntryRow[];
  approvedHours: number;
  pendingHours: number;
  rejectedHours: number;
}

export function isValidIsoDate(value: string): boolean {
  if (!isoDatePattern.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function todayInToronto(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  return `${values.year}-${values.month}-${values.day}`;
}

export function daysBetween(earlierIso: string, laterIso: string): number {
  const earlier = Date.parse(`${earlierIso}T00:00:00Z`);
  const later = Date.parse(`${laterIso}T00:00:00Z`);

  return Math.round((later - earlier) / 86_400_000);
}

function normalizeSpaces(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function roundHours(value: number): number {
  return Math.round(value * 100) / 100;
}

export class VolunteerService {
  private catalog: { loadedAt: number; data: VolunteerFormData } | null = null;

  constructor(
    private readonly repository: VolunteerRepository,
    private readonly adminUserIds: ReadonlySet<string> = new Set(),
  ) {}

  /** A placeholder key for a volunteer who has no Slack account. */
  newExternalVolunteerKey(): string {
    return `${EXTERNAL_VOLUNTEER_PREFIX}${randomUUID().replaceAll("-", "")}`;
  }

  /** Finds existing volunteers by name, UTORid or email, for exec pickers. */
  async searchVolunteers(
    requesterSlackUserId: string,
    query: string,
  ): Promise<VolunteerProfile[]> {
    const text = query.trim().slice(0, 60);

    if (!text || !(await this.canSubmitForOthers(requesterSlackUserId))) {
      return [];
    }

    return this.repository.searchProfiles(text, 20);
  }

  /**
   * Volunteer admins and execs (staff with the manage permission) can log
   * hours, and create a missing profile, on a volunteer's behalf.
   */
  async canSubmitForOthers(slackUserId: string): Promise<boolean> {
    if (this.adminUserIds.has(slackUserId)) {
      return true;
    }

    const staff = await this.repository.getStaffMember(slackUserId);

    return Boolean(staff?.canManage);
  }

  async getFormData(): Promise<VolunteerFormData> {
    if (this.catalog && Date.now() - this.catalog.loadedAt < CATALOG_TTL_MS) {
      return this.catalog.data;
    }

    const [categories, events, years] = await Promise.all([
      this.repository.listCategories(),
      this.repository.listEvents(),
      this.repository.listYears(),
    ]);

    const data: VolunteerFormData = {
      categories: categories.filter((category) => category.isActive),
      events: events.filter((event) => event.isActive),
      years,
    };
    this.catalog = { loadedAt: Date.now(), data };

    return data;
  }

  invalidateFormData(): void {
    this.catalog = null;
  }

  async getProfile(slackUserId: string): Promise<VolunteerProfile | null> {
    return this.repository.getProfile(slackUserId);
  }

  async getPrimaryApprover(): Promise<VolunteerStaffMember | null> {
    return this.repository.getPrimaryApprover();
  }

  async getStaffMember(
    slackUserId: string,
  ): Promise<VolunteerStaffMember | null> {
    return this.repository.getStaffMember(slackUserId);
  }

  /**
   * Saves a volunteer's profile. A volunteer is identified by their student
   * number (per student type), not by Slack, so:
   *
   * - an exec can add a volunteer who has no Slack account yet (`actor` is the
   *   exec, `slackUserId` is a placeholder key), and
   * - when that volunteer later signs in on Slack with the same details, their
   *   Slack account is linked to the existing record instead of creating a
   *   second one. A link needs the student number AND a second identifier to
   *   match (UTORid for UofT students, email for everyone else), and the record
   *   must not already belong to a Slack account. Anything short of that is
   *   refused and left for an exec to resolve.
   */
  async saveProfile(
    slackUserId: string,
    input: ProfileFormInput,
    actorSlackUserId: string = slackUserId,
  ): Promise<SaveProfileResult> {
    const issues: ProfileIssue[] = [];
    const byExec = actorSlackUserId !== slackUserId;
    const their = byExec ? "their" : "your";

    if (byExec) {
      // An exec adding a volunteer who hasn't set up a profile. An existing
      // profile is never overwritten this way; the volunteer owns it.
      if (!(await this.canSubmitForOthers(actorSlackUserId))) {
        return {
          ok: false,
          issues: [
            {
              field: "firstName",
              message: "You don't have permission to enter details for someone else.",
            },
          ],
        };
      }

      if (await this.repository.getProfile(slackUserId)) {
        return {
          ok: false,
          issues: [
            {
              field: "firstName",
              message:
                "That volunteer already has a profile. Close this and start again to use it.",
            },
          ],
        };
      }
    }

    const firstName = normalizeSpaces(input.firstName);
    const lastName = normalizeSpaces(input.lastName);
    const preferredEmail = input.preferredEmail.trim().toLowerCase();
    const email = input.email.trim().toLowerCase();
    const isUofT = input.studentType === "uoft";
    const utorid = input.utorid.trim().toLowerCase();
    const studentNumber = isUofT
      ? input.studentNumber.trim()
      : input.studentNumber.replace(/\s+/g, "").toUpperCase();

    if (!firstName) {
      issues.push({ field: "firstName", message: `Enter ${their} first name.` });
    } else if (firstName.length > 60) {
      issues.push({ field: "firstName", message: "That name is too long." });
    }

    if (!lastName) {
      issues.push({ field: "lastName", message: `Enter ${their} last name.` });
    } else if (lastName.length > 60) {
      issues.push({ field: "lastName", message: "That name is too long." });
    }

    if (!emailPattern.test(preferredEmail)) {
      issues.push({
        field: "preferredEmail",
        message: `Enter ${their} preferred email address.`,
      });
    }

    if (!emailPattern.test(email)) {
      issues.push({ field: "email", message: "Enter a valid email address." });
    }

    if (isUofT) {
      if (!utoridPattern.test(utorid)) {
        issues.push({
          field: "utorid",
          message: `Enter ${their} UTORid (3 to 16 letters or numbers, no spaces or @).`,
        });
      }

      if (!uoftStudentNumberPattern.test(studentNumber)) {
        issues.push({
          field: "studentNumber",
          message: `Enter ${their} student number (9 or 10 digits).`,
        });
      }
    } else if (!otherStudentNumberPattern.test(studentNumber)) {
      issues.push({
        field: "studentNumber",
        message: `Enter ${their} ${
          input.studentType === "high_school"
            ? "student number"
            : "university student ID"
        } (4 to 20 letters, numbers or dashes).`,
      });
    }

    if (issues.length > 0) {
      return { ok: false, issues };
    }

    const [own, byNumber, byUtorid] = await Promise.all([
      this.repository.getProfile(slackUserId),
      this.repository.findProfileByStudentKey(input.studentType, studentNumber),
      isUofT ? this.repository.findProfileByUtorid(utorid) : null,
    ]);
    const numberOwner =
      byNumber && byNumber.slackUserId !== slackUserId ? byNumber : null;
    const utoridOwner =
      byUtorid && byUtorid.slackUserId !== slackUserId ? byUtorid : null;
    let linkedFrom: string | null = null;

    if (numberOwner || utoridOwner) {
      // Is this a Slack volunteer showing up for a record an exec added?
      const linkable =
        !byExec &&
        !own &&
        numberOwner !== null &&
        !hasSlackAccount(numberOwner.slackUserId) &&
        (utoridOwner === null ||
          utoridOwner.slackUserId === numberOwner.slackUserId) &&
        (isUofT
          ? numberOwner.utorid?.toLowerCase() === utorid
          : numberOwner.email.toLowerCase() === email);

      if (!linkable || !numberOwner) {
        return { ok: false, issues: this.identityConflicts(byExec, numberOwner, utoridOwner) };
      }

      const linked = await this.repository.relinkProfile(
        numberOwner.slackUserId,
        slackUserId,
      );

      if (!linked) {
        // Someone else linked or changed that record a moment ago.
        return {
          ok: false,
          issues: [
            {
              field: "studentNumber",
              message:
                "That volunteer record just changed. Please try again, or ask an admin for help.",
            },
          ],
        };
      }

      linkedFrom = numberOwner.slackUserId;
    }

    const profileInput: VolunteerProfileInput = {
      studentType: input.studentType,
      firstName,
      lastName,
      preferredEmail,
      email,
      utorid: isUofT ? utorid : null,
      studentNumber,
    };

    return {
      ok: true,
      profile: await this.repository.upsertProfile(slackUserId, profileInput),
      linkedFrom,
    };
  }

  private identityConflicts(
    byExec: boolean,
    numberOwner: VolunteerProfile | null,
    utoridOwner: VolunteerProfile | null,
  ): ProfileIssue[] {
    const issues: ProfileIssue[] = [];

    if (numberOwner) {
      issues.push({
        field: "studentNumber",
        message: byExec
          ? `That student number already belongs to ${numberOwner.fullName}. Close this and pick them with "Find a volunteer" instead.`
          : hasSlackAccount(numberOwner.slackUserId)
            ? "That student number is already registered to another Slack account. Ask an admin for help."
            : "A volunteer record already exists for that student number, but your other details don't match it. Ask an admin to link it to your Slack account (/volunteer-admin).",
      });
    }

    if (utoridOwner && utoridOwner.slackUserId !== numberOwner?.slackUserId) {
      issues.push({
        field: "utorid",
        message: byExec
          ? `That UTORid already belongs to ${utoridOwner.fullName}. Close this and pick them with "Find a volunteer" instead.`
          : "That UTORid is already registered to another volunteer record. Ask an admin for help.",
      });
    }

    return issues;
  }

  async prepareSubmission(
    input: SubmissionInput,
  ): Promise<PrepareSubmissionResult> {
    const issues: SubmissionIssue[] = [];
    const description = input.description.trim();
    const submittedBy = input.submittedBySlackUserId ?? input.volunteerSlackUserId;
    const onBehalf = submittedBy !== input.volunteerSlackUserId;

    if (onBehalf && !(await this.canSubmitForOthers(submittedBy))) {
      return {
        ok: false,
        issues: [
          {
            target: "general",
            message: "You don't have permission to log hours for someone else.",
          },
        ],
      };
    }

    if (!description) {
      issues.push({
        target: "description",
        message: "Describe what you did.",
      });
    } else if (description.length > MAX_DESCRIPTION_LENGTH) {
      issues.push({
        target: "description",
        message: `Keep this under ${MAX_DESCRIPTION_LENGTH} characters.`,
      });
    }

    if (input.entries.length < 1) {
      issues.push({
        target: "general",
        message: "Add at least one date with hours.",
      });
    }

    if (input.entries.length > MAX_ENTRIES_PER_SUBMISSION) {
      issues.push({
        target: "general",
        message: `A submission can include at most ${MAX_ENTRIES_PER_SUBMISSION} dates. Submit the rest separately.`,
      });
    }

    const seenDates = new Set<string>();
    const entries: EntryInput[] = input.entries.map((entry) => ({
      entryDate: entry.entryDate,
      hours: roundHours(entry.hours),
    }));

    entries.forEach((entry, index) => {
      if (!isValidIsoDate(entry.entryDate)) {
        issues.push({
          target: "entry",
          index,
          field: "date",
          message: "Choose a valid date.",
        });
        return;
      }

      if (seenDates.has(entry.entryDate)) {
        issues.push({
          target: "entry",
          index,
          field: "date",
          message: "This date is already in your submission.",
        });
      }
      seenDates.add(entry.entryDate);

      if (!Number.isFinite(entry.hours) || entry.hours <= 0) {
        issues.push({
          target: "entry",
          index,
          field: "hours",
          message: "Hours must be greater than 0.",
        });
      } else if (entry.hours > MAX_HOURS_PER_DAY) {
        issues.push({
          target: "entry",
          index,
          field: "hours",
          message: `Hours can't be more than ${MAX_HOURS_PER_DAY} in a day.`,
        });
      }
    });

    if (issues.length > 0) {
      return { ok: false, issues };
    }

    const [profile, formData] = await Promise.all([
      this.repository.getProfile(input.volunteerSlackUserId),
      this.getFormData(),
    ]);

    if (!profile) {
      return {
        ok: false,
        issues: [
          {
            target: "general",
            message: onBehalf
              ? "That volunteer has no profile yet. Start again from /volunteer-admin (Log hours for someone) to enter their details."
              : "Set up your volunteer profile first by opening /volunteer and choosing Log hours again.",
          },
        ],
      };
    }

    // Editing a request: its own category and event stay valid even if an exec
    // has since deactivated them, so fixing the hours never forces a change.
    const existing = input.editingSubmissionId
      ? await this.repository.getSubmission(input.editingSubmissionId)
      : null;
    const keptCategory =
      existing && existing.categoryId === input.categoryId
        ? (await this.repository.listCategories()).find(
            (candidate) => candidate.id === existing.categoryId,
          )
        : undefined;
    const category =
      formData.categories.find((candidate) => candidate.id === input.categoryId) ??
      keptCategory;

    if (!category) {
      issues.push({
        target: "category",
        message: "That category is no longer available. Pick another.",
      });
    }

    let eventId: string | null = null;
    if (category?.requiresEvent) {
      const keptEvent =
        existing?.eventId && existing.eventId === input.eventId
          ? (await this.repository.listEvents()).find(
              (candidate) => candidate.id === existing.eventId,
            )
          : undefined;
      const event =
        formData.events.find((candidate) => candidate.id === input.eventId) ??
        keptEvent;

      if (!event) {
        issues.push({
          target: "event",
          message: "Pick the event you volunteered at.",
        });
      } else {
        eventId = event.id;
      }
    }

    const preparedEntries = entries.flatMap((entry, index) => {
      const year = formData.years.find(
        (candidate) =>
          entry.entryDate >= candidate.startDate &&
          entry.entryDate <= candidate.endDate,
      );

      if (!year) {
        issues.push({
          target: "entry",
          index,
          field: "date",
          message:
            "This date isn't in a volunteer year yet. Check the date, or ask an admin to add the year.",
        });
        return [];
      }

      return [{ ...entry, yearId: year.id }];
    });

    const existingTotals = await this.repository.sumHoursByDate(
      input.volunteerSlackUserId,
      entries.map((entry) => entry.entryDate),
      input.editingSubmissionId,
    );

    entries.forEach((entry, index) => {
      const existing = existingTotals.get(entry.entryDate) ?? 0;

      if (roundHours(existing + entry.hours) > MAX_HOURS_PER_DAY) {
        issues.push({
          target: "entry",
          index,
          field: "hours",
          message: `${onBehalf ? "They already have" : "You already have"} ${existing} h logged on this date, which would pass ${MAX_HOURS_PER_DAY} h.`,
        });
      }
    });

    if (issues.length > 0) {
      return { ok: false, issues };
    }

    // An exec entering or correcting hours is the approval; a volunteer
    // editing their own request sends it back to the approvers.
    const approvedBy =
      onBehalf ||
      (input.editingSubmissionId !== undefined &&
        (await this.canSubmitForOthers(submittedBy)))
        ? submittedBy
        : null;

    return {
      ok: true,
      prepared: {
        id: input.editingSubmissionId ?? randomUUID(),
        slackSubmissionId: input.slackSubmissionId,
        volunteerSlackUserId: input.volunteerSlackUserId,
        submittedBySlackUserId: submittedBy,
        approvedBySlackUserId: approvedBy,
        categoryId: input.categoryId,
        eventId,
        description,
        entries: preparedEntries,
      },
    };
  }

  /** A volunteer's own requests, newest first, for them to pick one to edit. */
  /**
   * The approvers' queue: requests waiting for a decision, oldest first, plus
   * how many there are in all. Execs and admins can look; only staff who can
   * approve get `canApprove`. Null for anyone else.
   */
  async getPendingQueue(actorSlackUserId: string): Promise<{
    requests: VolunteerSubmission[];
    total: number;
    canApprove: boolean;
  } | null> {
    const staff = await this.repository.getStaffMember(actorSlackUserId);

    if (
      !staff?.canApprove &&
      !(await this.canSubmitForOthers(actorSlackUserId))
    ) {
      return null;
    }

    const [requests, total] = await Promise.all([
      this.repository.listPendingSubmissions(PENDING_QUEUE_PAGE),
      this.repository.countPendingSubmissions(),
    ]);

    return { requests, total, canApprove: Boolean(staff?.canApprove) };
  }

  async listMyRequests(slackUserId: string): Promise<VolunteerSubmission[]> {
    return this.repository.listSubmissionsForVolunteer(slackUserId, 100);
  }

  /** Any volunteer's requests, for execs looking one up. Null if not an exec. */
  async listRequestsFor(
    actorSlackUserId: string,
    volunteerSlackUserId: string,
  ): Promise<VolunteerSubmission[] | null> {
    if (!(await this.canSubmitForOthers(actorSlackUserId))) {
      return null;
    }

    return this.repository.listSubmissionsForVolunteer(volunteerSlackUserId, 100);
  }

  /**
   * Who may change a request: the volunteer it belongs to, or an exec. Nobody
   * may once any of its hours were marked as sent to CCR.
   */
  async getRequestForEdit(
    actorSlackUserId: string,
    submissionId: string,
  ): Promise<EditAccess> {
    const submission = await this.repository.getSubmission(submissionId);

    if (!submission) {
      return { status: "not_found" };
    }

    const isExec = await this.canSubmitForOthers(actorSlackUserId);

    if (submission.volunteerSlackUserId !== actorSlackUserId && !isExec) {
      return { status: "not_allowed" };
    }

    if (submission.entries.some((entry) => entry.ccrSentAt !== null)) {
      return { status: "locked" };
    }

    return { status: "ok", submission, asExec: isExec };
  }

  /**
   * Applies an edit prepared with `editingSubmissionId`. The rules are checked
   * again here, so a stale or forged form can't change someone else's hours.
   * A volunteer's edit goes back to pending; an exec's edit is approved.
   */
  async applyEdit(
    prepared: PreparedSubmission,
    editorSlackUserId: string,
  ): Promise<EditOutcome> {
    const access = await this.getRequestForEdit(editorSlackUserId, prepared.id);

    if (access.status !== "ok") {
      return { status: access.status };
    }

    const before = access.submission;

    if (before.volunteerSlackUserId !== prepared.volunteerSlackUserId) {
      return { status: "not_allowed" };
    }

    const entries = [...prepared.entries].sort((left, right) =>
      left.entryDate.localeCompare(right.entryDate),
    );
    const unchanged =
      before.categoryId === prepared.categoryId &&
      before.eventId === prepared.eventId &&
      before.description === prepared.description &&
      before.entries.length === entries.length &&
      before.entries.every((entry, index) => {
        const next = entries[index];

        return (
          next !== undefined &&
          next.entryDate === entry.entryDate &&
          next.hours === entry.hours
        );
      });

    if (unchanged) {
      // Nothing to save, and it must not send approved hours back for review.
      return { status: "unchanged", submission: before };
    }

    const edit: SubmissionEdit = {
      submissionId: prepared.id,
      categoryId: prepared.categoryId,
      eventId: prepared.eventId,
      description: prepared.description,
      entries,
      editedBySlackUserId: editorSlackUserId,
      approvedBySlackUserId: access.asExec ? editorSlackUserId : null,
    };
    const result = await this.repository.updateSubmission(edit, {
      before: snapshotOf(before),
      after: {
        categoryId: edit.categoryId,
        eventId: edit.eventId,
        description: edit.description,
        status: access.asExec ? "approved" : "pending",
        entries: entries.map((entry) => ({
          entryDate: entry.entryDate,
          hours: entry.hours,
        })),
      },
    });

    return result.status === "ok"
      ? {
          status: "ok",
          before,
          submission: result.submission,
          needsApproval: result.submission.status === "pending",
        }
      : { status: result.status };
  }

  /** Execs can delete a request, for example one entered for the wrong person. */
  async deleteRequest(
    actorSlackUserId: string,
    submissionId: string,
  ): Promise<DeleteOutcome> {
    if (!(await this.canSubmitForOthers(actorSlackUserId))) {
      return { status: "not_allowed" };
    }

    const submission = await this.repository.getSubmission(submissionId);

    if (!submission) {
      return { status: "not_found" };
    }

    const result = await this.repository.deleteSubmission(
      submissionId,
      actorSlackUserId,
      snapshotOf(submission),
    );

    return result.status === "ok" ? { status: "ok", submission } : result;
  }

  async createSubmission(
    prepared: PreparedSubmission,
  ): Promise<CreateSubmissionResult> {
    return this.repository.createSubmission(prepared);
  }

  async recordApprovalMessage(
    submissionId: string,
    channelId: string,
    messageTs: string,
  ): Promise<void> {
    await this.repository.setApprovalMessage(
      submissionId,
      channelId,
      messageTs,
    );
  }

  async getSubmission(id: string): Promise<VolunteerSubmission | null> {
    return this.repository.getSubmission(id);
  }

  async decide(input: DecideInput): Promise<DecisionResult> {
    const staff = await this.repository.getStaffMember(
      input.decidedBySlackUserId,
    );

    if (!staff?.canApprove) {
      return { status: "not_authorized" };
    }

    const note = input.note?.trim() || null;

    if (input.decision === "rejected" && !note) {
      return { status: "note_required" };
    }

    const decided = await this.repository.decideSubmission(
      input.submissionId,
      input.decision,
      input.decidedBySlackUserId,
      input.decision === "rejected" ? note : null,
      input.expectedVersion,
    );

    if (decided) {
      return { status: "ok", submission: decided };
    }

    const existing = await this.repository.getSubmission(input.submissionId);

    if (!existing) {
      return { status: "not_found" };
    }

    // Still pending, so the only reason it wasn't decided is that it was edited
    // after the approver's card was shown.
    return existing.status === "pending"
      ? { status: "stale", submission: existing }
      : { status: "already_decided", submission: existing };
  }

  async getMyHours(slackUserId: string): Promise<MyHours> {
    const rows = await this.repository.listEntriesForVolunteer(
      slackUserId,
      500,
    );
    const totals = { approved: 0, pending: 0, rejected: 0 };

    for (const row of rows) {
      totals[row.status] = roundHours(totals[row.status] + row.hours);
    }

    return {
      rows,
      approvedHours: totals.approved,
      pendingHours: totals.pending,
      rejectedHours: totals.rejected,
    };
  }
}
