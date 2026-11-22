export type StudentType = "uoft" | "other_university" | "high_school";

/**
 * Volunteers are keyed by Slack user ID. A volunteer an exec enters hours for
 * may have no Slack account at all, so they get a placeholder key that starts
 * with this prefix instead. It can never collide with a real Slack ID.
 */
export const EXTERNAL_VOLUNTEER_PREFIX = "ext_";

export function hasSlackAccount(volunteerKey: string): boolean {
  return !volunteerKey.startsWith(EXTERNAL_VOLUNTEER_PREFIX);
}

export const studentTypeLabels: Record<StudentType, string> = {
  uoft: "UofT student",
  other_university: "University student outside UofT",
  high_school: "High school student",
};

export interface VolunteerProfile {
  /** A Slack user ID, or an `ext_...` placeholder until they are on Slack. */
  slackUserId: string;
  studentType: StudentType;
  firstName: string;
  lastName: string;
  fullName: string;
  /** Where to contact them; asked of every student type. */
  preferredEmail: string;
  /** UofT email, university email, or plain email, by student type. */
  email: string;
  utorid: string | null;
  /** Student number (UofT, high school) or student ID (other university). */
  studentNumber: string;
}

export interface VolunteerProfileInput {
  studentType: StudentType;
  firstName: string;
  lastName: string;
  preferredEmail: string;
  email: string;
  utorid: string | null;
  studentNumber: string;
}

export interface VolunteerYear {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
}

/** What has been logged against one volunteer year. */
export interface YearStats {
  yearId: string;
  /** Volunteers with at least one logged date in the year. */
  volunteers: number;
  approvedHours: number;
  pendingHours: number;
  rejectedHours: number;
  /** Approved hours already marked as sent to CCR. */
  sentHours: number;
}

export type UpdateYearResult =
  | { status: "updated"; year: VolunteerYear }
  | { status: "not_found" }
  /** Some logged dates would fall outside the new dates. */
  | { status: "entries_outside"; count: number };

export type DeleteYearResult = "deleted" | "not_found" | "in_use";

export interface VolunteerCategory {
  id: string;
  name: string;
  requiresEvent: boolean;
  isActive: boolean;
  sortOrder: number;
}

export interface VolunteerEvent {
  id: string;
  name: string;
  eventDate: string | null;
  isActive: boolean;
}

export interface VolunteerStaffMember {
  slackUserId: string;
  displayName: string | null;
  title: string | null;
  canApprove: boolean;
  canManage: boolean;
  isPrimary: boolean;
}

export type SubmissionStatus = "pending" | "approved" | "rejected";

export interface EntryInput {
  entryDate: string;
  hours: number;
}

export interface PreparedEntry extends EntryInput {
  yearId: string;
}

export interface PreparedSubmission {
  id: string;
  slackSubmissionId: string;
  volunteerSlackUserId: string;
  /** The volunteer, or an admin who entered the hours on their behalf. */
  submittedBySlackUserId: string;
  /**
   * Set when an exec entered the hours for the volunteer: their entry counts
   * as the approval, so the submission is saved already approved by them.
   */
  approvedBySlackUserId: string | null;
  categoryId: string;
  eventId: string | null;
  description: string;
  entries: PreparedEntry[];
}

export interface SubmissionEntry {
  id: string;
  entryDate: string;
  hours: number;
  yearId: string;
  /** Set once the hours were marked as sent to CCR; the request is then locked. */
  ccrSentAt: string | null;
}

export interface VolunteerSubmission {
  id: string;
  slackSubmissionId: string;
  volunteerSlackUserId: string;
  submittedBySlackUserId: string;
  volunteerName: string;
  studentType: StudentType;
  categoryId: string;
  categoryName: string;
  eventId: string | null;
  eventName: string | null;
  description: string;
  status: SubmissionStatus;
  decidedBySlackUserId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  approvalChannelId: string | null;
  approvalMessageTs: string | null;
  submittedAt: string;
  /** Set when someone changed the request after it was submitted. */
  editedBySlackUserId: string | null;
  editedAt: string | null;
  /** Bumped by every edit; approval buttons carry it to refuse stale clicks. */
  version: number;
  entries: SubmissionEntry[];
}

export interface VolunteerEntryRow {
  entryDate: string;
  hours: number;
  status: SubmissionStatus;
  categoryName: string;
  eventName: string | null;
  description: string;
  decisionNote: string | null;
  /** True when an admin, not the volunteer, entered this on their behalf. */
  enteredByStaff: boolean;
}

/** A change to an existing request's category, event, description and dates. */
export interface SubmissionEdit {
  submissionId: string;
  categoryId: string;
  eventId: string | null;
  description: string;
  entries: PreparedEntry[];
  editedBySlackUserId: string;
  /**
   * Set when the editor is an exec: their edit counts as the approval. Left
   * null when the volunteer edits, which sends the request back to pending.
   */
  approvedBySlackUserId: string | null;
}

/** What the audit trail stores about a request, before or after a change. */
export interface SubmissionSnapshot {
  categoryId: string;
  eventId: string | null;
  description: string;
  status: SubmissionStatus;
  entries: Array<{ entryDate: string; hours: number }>;
}

export type UpdateSubmissionResult =
  | { status: "ok"; submission: VolunteerSubmission }
  | { status: "not_found" }
  | { status: "locked" };

export type DeleteSubmissionResult =
  | { status: "ok" }
  | { status: "not_found" }
  | { status: "locked" };

export interface CreateSubmissionResult {
  submission: VolunteerSubmission;
  created: boolean;
}

export type SubmissionIssue =
  | {
      target: "category" | "event" | "description" | "general";
      message: string;
    }
  | {
      target: "entry";
      index: number;
      field: "date" | "hours";
      message: string;
    };

export type ProfileIssueField =
  | "studentType"
  | "firstName"
  | "lastName"
  | "preferredEmail"
  | "email"
  | "utorid"
  | "studentNumber";

export interface ProfileIssue {
  field: ProfileIssueField;
  message: string;
}
