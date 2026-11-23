import type {
  CreateSubmissionResult,
  DeleteSubmissionResult,
  PreparedSubmission,
  SubmissionEdit,
  SubmissionSnapshot,
  UpdateSubmissionResult,
  VolunteerCategory,
  VolunteerEntryRow,
  VolunteerEvent,
  VolunteerProfile,
  StudentType,
  VolunteerProfileInput,
  VolunteerStaffMember,
  VolunteerSubmission,
  VolunteerYear,
  YearStats,
  UpdateYearResult,
  DeleteYearResult,
} from "../domain/volunteer.js";
import type {
  MarkSentResult,
  ReportEntry,
  ReportExport,
  ReportExportInput,
  ReportFilters,
} from "../domain/volunteer-report.js";

export interface VolunteerRepository {
  getProfile(slackUserId: string): Promise<VolunteerProfile | null>;
  findProfileByUtorid(utorid: string): Promise<VolunteerProfile | null>;
  /** The identity key: one volunteer per (student type, student number). */
  findProfileByStudentKey(
    studentType: StudentType,
    studentNumber: string,
  ): Promise<VolunteerProfile | null>;
  /**
   * Re-keys a volunteer who has no Slack account (`ext_...`) to a real Slack
   * user ID, carrying their submissions along. Returns false if no such
   * placeholder volunteer exists (for example, someone else linked it first).
   * Throws if the Slack ID already has a profile.
   */
  relinkProfile(placeholderKey: string, slackUserId: string): Promise<boolean>;
  upsertProfile(
    slackUserId: string,
    input: VolunteerProfileInput,
  ): Promise<VolunteerProfile>;
  /** Case-insensitive match on name, UTORid or email; best matches by name. */
  searchProfiles(query: string, limit: number): Promise<VolunteerProfile[]>;

  listCategories(): Promise<VolunteerCategory[]>;
  listEvents(): Promise<VolunteerEvent[]>;
  listYears(): Promise<VolunteerYear[]>;

  getStaffMember(slackUserId: string): Promise<VolunteerStaffMember | null>;
  getPrimaryApprover(): Promise<VolunteerStaffMember | null>;

  /** A volunteer's requests with their dates, newest first. */
  /** Requests waiting for a decision, oldest first. */
  listPendingSubmissions(limit: number): Promise<VolunteerSubmission[]>;
  countPendingSubmissions(): Promise<number>;
  listSubmissionsForVolunteer(
    slackUserId: string,
    limit: number,
  ): Promise<VolunteerSubmission[]>;
  /**
   * Changes a request's category, event, description and dates in one atomic
   * step, and writes the audit row. Refused if any of its hours were already
   * sent to CCR. Dates kept from before keep their entry (and its history).
   */
  updateSubmission(
    edit: SubmissionEdit,
    audit: { before: SubmissionSnapshot; after: SubmissionSnapshot },
  ): Promise<UpdateSubmissionResult>;
  /** Deletes a request and its dates, writing the audit row first. */
  deleteSubmission(
    id: string,
    deletedBySlackUserId: string,
    before: SubmissionSnapshot,
  ): Promise<DeleteSubmissionResult>;
  /**
   * Hours already pending or approved per date. `excludeSubmissionId` leaves
   * one request out, so editing it doesn't count against its own hours.
   */
  sumHoursByDate(
    slackUserId: string,
    dates: string[],
    excludeSubmissionId?: string,
  ): Promise<Map<string, number>>;
  createSubmission(
    submission: PreparedSubmission,
  ): Promise<CreateSubmissionResult>;
  getSubmission(id: string): Promise<VolunteerSubmission | null>;
  setApprovalMessage(
    id: string,
    channelId: string,
    messageTs: string,
  ): Promise<void>;
  /**
   * Decides a pending request. When `expectedVersion` is given the request must
   * still be at that version, so a decision made on a card that has since been
   * edited is refused. Returns null if nothing was decided.
   */
  decideSubmission(
    id: string,
    decision: "approved" | "rejected",
    decidedBySlackUserId: string,
    note: string | null,
    expectedVersion?: number,
  ): Promise<VolunteerSubmission | null>;
  listEntriesForVolunteer(
    slackUserId: string,
    limit: number,
  ): Promise<VolunteerEntryRow[]>;

  listReportEntries(filters: ReportFilters): Promise<ReportEntry[]>;
  createExport(input: ReportExportInput): Promise<ReportExport>;
  getExport(id: string): Promise<ReportExport | null>;
  markExportSent(
    id: string,
    markedBySlackUserId: string,
  ): Promise<MarkSentResult>;

  listStaff(): Promise<VolunteerStaffMember[]>;
  upsertStaffMember(
    member: VolunteerStaffMember,
    addedBySlackUserId: string,
  ): Promise<void>;
  removeStaffMember(slackUserId: string): Promise<boolean>;
  createCategory(
    name: string,
    requiresEvent: boolean,
  ): Promise<VolunteerCategory>;
  updateCategory(
    id: string,
    changes: { name?: string; isActive?: boolean },
  ): Promise<VolunteerCategory | null>;
  createEvent(
    name: string,
    eventDate: string | null,
    createdBySlackUserId: string,
  ): Promise<VolunteerEvent>;
  setEventActive(id: string, isActive: boolean): Promise<boolean>;
  createYear(
    label: string,
    startDate: string,
    endDate: string,
  ): Promise<VolunteerYear>;
  listYearStats(): Promise<YearStats[]>;
  /**
   * Renames a year and/or moves its dates. Refused, in the same statement that
   * would make the change, when any date logged against the year would fall
   * outside the new dates.
   */
  updateYear(
    id: string,
    label: string,
    startDate: string,
    endDate: string,
  ): Promise<UpdateYearResult>;
  /** Deletes a year only when nothing is logged against it and no report used it. */
  deleteYear(id: string): Promise<DeleteYearResult>;
  /**
   * Makes one year the default (clearing any other), or clears the default
   * when `id` is null. Returns false, changing nothing, if the year doesn't
   * exist.
   */
  setDefaultYear(id: string | null): Promise<boolean>;
  updateEvent(
    id: string,
    name: string,
    eventDate: string | null,
  ): Promise<VolunteerEvent | null>;
}
