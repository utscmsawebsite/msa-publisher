import { randomUUID } from "node:crypto";
import type {
  MarkSentResult,
  ReportEntry,
  ReportExport,
  ReportExportInput,
  ReportFilters,
} from "../domain/volunteer-report.js";
import {
  EXTERNAL_VOLUNTEER_PREFIX,
  type CreateSubmissionResult,
  type DeleteSubmissionResult,
  type PreparedSubmission,
  type SubmissionEdit,
  type SubmissionSnapshot,
  type UpdateSubmissionResult,
  type StudentType,
  type SubmissionEntry,
  type SubmissionStatus,
  type VolunteerCategory,
  type VolunteerEntryRow,
  type VolunteerEvent,
  type VolunteerProfile,
  type VolunteerProfileInput,
  type VolunteerStaffMember,
  type VolunteerSubmission,
  type VolunteerYear,
  type YearStats,
  type UpdateYearResult,
  type DeleteYearResult,
} from "../domain/volunteer.js";
import type { VolunteerRepository } from "./volunteer.repository.js";

export interface InMemoryVolunteerSeed {
  categories?: VolunteerCategory[];
  events?: VolunteerEvent[];
  years?: VolunteerYear[];
  staff?: VolunteerStaffMember[];
}

interface StoredSubmission {
  prepared: PreparedSubmission;
  status: SubmissionStatus;
  decidedBySlackUserId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  approvalChannelId: string | null;
  approvalMessageTs: string | null;
  submittedAt: string;
  editedBySlackUserId: string | null;
  editedAt: string | null;
  version: number;
  entryIds: string[];
}

export interface RecordedChange {
  submissionId: string;
  volunteerSlackUserId: string;
  changedBySlackUserId: string;
  action: "edit" | "delete";
  before: SubmissionSnapshot;
  after: SubmissionSnapshot | null;
}

export class InMemoryVolunteerRepository implements VolunteerRepository {
  private readonly profiles = new Map<string, VolunteerProfile>();
  private readonly submissions = new Map<string, StoredSubmission>();
  private readonly exports = new Map<
    string,
    { export: ReportExport; entryIds: string[] }
  >();
  private readonly entrySentAt = new Map<string, string>();
  /** The audit trail, exposed so tests can check what was recorded. */
  readonly changes: RecordedChange[] = [];
  private readonly categories: VolunteerCategory[];
  private readonly events: VolunteerEvent[];
  private readonly years: VolunteerYear[];
  private readonly staff: VolunteerStaffMember[];

  constructor(seed: InMemoryVolunteerSeed = {}) {
    this.categories = seed.categories ?? [];
    this.events = seed.events ?? [];
    this.years = seed.years ?? [];
    this.staff = seed.staff ?? [];
  }

  async getProfile(slackUserId: string): Promise<VolunteerProfile | null> {
    return this.profiles.get(slackUserId) ?? null;
  }

  async searchProfiles(
    query: string,
    limit: number,
  ): Promise<VolunteerProfile[]> {
    const needle = query.toLowerCase();

    return [...this.profiles.values()]
      .filter((profile) =>
        [
          profile.fullName,
          profile.utorid,
          profile.studentNumber,
          profile.email,
        ].some((value) =>
          value?.toLowerCase().includes(needle),
        ),
      )
      .sort((left, right) => left.fullName.localeCompare(right.fullName))
      .slice(0, limit);
  }

  async findProfileByUtorid(utorid: string): Promise<VolunteerProfile | null> {
    return (
      [...this.profiles.values()].find(
        (profile) => profile.utorid?.toLowerCase() === utorid.toLowerCase(),
      ) ?? null
    );
  }

  async findProfileByStudentKey(
    studentType: StudentType,
    studentNumber: string,
  ): Promise<VolunteerProfile | null> {
    return (
      [...this.profiles.values()].find(
        (profile) =>
          profile.studentType === studentType &&
          profile.studentNumber.toLowerCase() === studentNumber.toLowerCase(),
      ) ?? null
    );
  }

  async relinkProfile(
    placeholderKey: string,
    slackUserId: string,
  ): Promise<boolean> {
    const profile = this.profiles.get(placeholderKey);

    if (!profile || !placeholderKey.startsWith(EXTERNAL_VOLUNTEER_PREFIX)) {
      return false;
    }

    if (this.profiles.has(slackUserId)) {
      throw new Error("That Slack user already has a volunteer profile.");
    }

    this.profiles.delete(placeholderKey);
    this.profiles.set(slackUserId, { ...profile, slackUserId });

    // Mirrors ON UPDATE CASCADE: the volunteer's submissions follow the key.
    for (const stored of this.submissions.values()) {
      if (stored.prepared.volunteerSlackUserId === placeholderKey) {
        stored.prepared = {
          ...stored.prepared,
          volunteerSlackUserId: slackUserId,
        };
      }
    }

    return true;
  }

  async upsertProfile(
    slackUserId: string,
    input: VolunteerProfileInput,
  ): Promise<VolunteerProfile> {
    const profile: VolunteerProfile = {
      slackUserId,
      ...input,
      fullName: `${input.firstName} ${input.lastName}`,
    };
    this.profiles.set(slackUserId, profile);
    return profile;
  }

  async listCategories(): Promise<VolunteerCategory[]> {
    return [...this.categories];
  }

  async listEvents(): Promise<VolunteerEvent[]> {
    return [...this.events];
  }

  async listYears(): Promise<VolunteerYear[]> {
    return [...this.years];
  }

  async getStaffMember(
    slackUserId: string,
  ): Promise<VolunteerStaffMember | null> {
    return this.staff.find((member) => member.slackUserId === slackUserId) ?? null;
  }

  async getPrimaryApprover(): Promise<VolunteerStaffMember | null> {
    return this.staff.find((member) => member.isPrimary) ?? null;
  }

  async sumHoursByDate(
    slackUserId: string,
    dates: string[],
    excludeSubmissionId?: string,
  ): Promise<Map<string, number>> {
    const totals = new Map<string, number>();

    for (const stored of this.submissions.values()) {
      if (
        stored.prepared.volunteerSlackUserId !== slackUserId ||
        stored.status === "rejected" ||
        stored.prepared.id === excludeSubmissionId
      ) {
        continue;
      }

      for (const entry of stored.prepared.entries) {
        if (dates.includes(entry.entryDate)) {
          totals.set(
            entry.entryDate,
            (totals.get(entry.entryDate) ?? 0) + entry.hours,
          );
        }
      }
    }

    return totals;
  }

  async createSubmission(
    submission: PreparedSubmission,
  ): Promise<CreateSubmissionResult> {
    const existing = [...this.submissions.values()].find(
      (stored) =>
        stored.prepared.slackSubmissionId === submission.slackSubmissionId,
    );

    if (existing) {
      return {
        submission: this.toSubmission(existing),
        created: false,
      };
    }

    const approvedBy = submission.approvedBySlackUserId;
    const stored: StoredSubmission = {
      prepared: submission,
      status: approvedBy ? "approved" : "pending",
      decidedBySlackUserId: approvedBy,
      decidedAt: approvedBy ? new Date().toISOString() : null,
      decisionNote: null,
      approvalChannelId: null,
      approvalMessageTs: null,
      submittedAt: new Date().toISOString(),
      editedBySlackUserId: null,
      editedAt: null,
      version: 0,
      entryIds: submission.entries.map(() => randomUUID()),
    };
    this.submissions.set(submission.id, stored);

    return { submission: this.toSubmission(stored), created: true };
  }

  async getSubmission(id: string): Promise<VolunteerSubmission | null> {
    const stored = this.submissions.get(id);
    return stored ? this.toSubmission(stored) : null;
  }

  async setApprovalMessage(
    id: string,
    channelId: string,
    messageTs: string,
  ): Promise<void> {
    const stored = this.submissions.get(id);

    if (stored) {
      stored.approvalChannelId = channelId;
      stored.approvalMessageTs = messageTs;
    }
  }

  async listPendingSubmissions(limit: number): Promise<VolunteerSubmission[]> {
    return [...this.submissions.values()]
      .filter((stored) => stored.status === "pending")
      .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt))
      .slice(0, limit)
      .map((stored) => this.toSubmission(stored));
  }

  async countPendingSubmissions(): Promise<number> {
    return [...this.submissions.values()].filter(
      (stored) => stored.status === "pending",
    ).length;
  }

  async listSubmissionsForVolunteer(
    slackUserId: string,
    limit: number,
  ): Promise<VolunteerSubmission[]> {
    return [...this.submissions.values()]
      .filter((stored) => stored.prepared.volunteerSlackUserId === slackUserId)
      .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt))
      .slice(0, limit)
      .map((stored) => this.toSubmission(stored));
  }

  private isLocked(stored: StoredSubmission): boolean {
    return stored.entryIds.some((entryId) => this.entrySentAt.has(entryId));
  }

  async updateSubmission(
    edit: SubmissionEdit,
    audit: { before: SubmissionSnapshot; after: SubmissionSnapshot },
  ): Promise<UpdateSubmissionResult> {
    const stored = this.submissions.get(edit.submissionId);

    if (!stored) {
      return { status: "not_found" };
    }

    if (this.isLocked(stored)) {
      return { status: "locked" };
    }

    // Dates that stay keep their entry id, as the database keeps their row.
    const previousIds = new Map(
      stored.prepared.entries.map((entry, index) => [
        entry.entryDate,
        stored.entryIds[index] ?? randomUUID(),
      ]),
    );
    const entries = [...edit.entries].sort((left, right) =>
      left.entryDate.localeCompare(right.entryDate),
    );

    stored.entryIds = entries.map(
      (entry) => previousIds.get(entry.entryDate) ?? randomUUID(),
    );
    stored.prepared = {
      ...stored.prepared,
      categoryId: edit.categoryId,
      eventId: edit.eventId,
      description: edit.description,
      entries,
    };
    stored.status = edit.approvedBySlackUserId ? "approved" : "pending";
    stored.decidedBySlackUserId = edit.approvedBySlackUserId;
    stored.decidedAt = edit.approvedBySlackUserId
      ? new Date().toISOString()
      : null;
    stored.decisionNote = null;
    stored.editedBySlackUserId = edit.editedBySlackUserId;
    stored.editedAt = new Date().toISOString();
    stored.version += 1;
    this.changes.push({
      submissionId: stored.prepared.id,
      volunteerSlackUserId: stored.prepared.volunteerSlackUserId,
      changedBySlackUserId: edit.editedBySlackUserId,
      action: "edit",
      before: audit.before,
      after: audit.after,
    });

    return { status: "ok", submission: this.toSubmission(stored) };
  }

  async deleteSubmission(
    id: string,
    deletedBySlackUserId: string,
    before: SubmissionSnapshot,
  ): Promise<DeleteSubmissionResult> {
    const stored = this.submissions.get(id);

    if (!stored) {
      return { status: "not_found" };
    }

    if (this.isLocked(stored)) {
      return { status: "locked" };
    }

    this.changes.push({
      submissionId: id,
      volunteerSlackUserId: stored.prepared.volunteerSlackUserId,
      changedBySlackUserId: deletedBySlackUserId,
      action: "delete",
      before,
      after: null,
    });
    this.submissions.delete(id);

    return { status: "ok" };
  }

  async decideSubmission(
    id: string,
    decision: "approved" | "rejected",
    decidedBySlackUserId: string,
    note: string | null,
    expectedVersion?: number,
  ): Promise<VolunteerSubmission | null> {
    const stored = this.submissions.get(id);

    if (!stored || stored.status !== "pending") {
      return null;
    }

    if (expectedVersion !== undefined && stored.version !== expectedVersion) {
      return null;
    }

    stored.status = decision;
    stored.decidedBySlackUserId = decidedBySlackUserId;
    stored.decidedAt = new Date().toISOString();
    stored.decisionNote = note;

    return this.toSubmission(stored);
  }

  async listEntriesForVolunteer(
    slackUserId: string,
    limit: number,
  ): Promise<VolunteerEntryRow[]> {
    const rows: VolunteerEntryRow[] = [];

    for (const stored of this.submissions.values()) {
      if (stored.prepared.volunteerSlackUserId !== slackUserId) {
        continue;
      }

      const category = this.categories.find(
        (candidate) => candidate.id === stored.prepared.categoryId,
      );
      const event = this.events.find(
        (candidate) => candidate.id === stored.prepared.eventId,
      );

      for (const entry of stored.prepared.entries) {
        rows.push({
          entryDate: entry.entryDate,
          hours: entry.hours,
          status: stored.status,
          categoryName: category?.name ?? "Unknown",
          eventName: event?.name ?? null,
          description: stored.prepared.description,
          decisionNote: stored.decisionNote,
          enteredByStaff:
            stored.prepared.submittedBySlackUserId !==
            stored.prepared.volunteerSlackUserId,
        });
      }
    }

    return rows
      .sort((left, right) => right.entryDate.localeCompare(left.entryDate))
      .slice(0, limit);
  }

  async listReportEntries(filters: ReportFilters): Promise<ReportEntry[]> {
    const rows: ReportEntry[] = [];
    const year = this.years.find((candidate) => candidate.id === filters.yearId);

    for (const stored of this.submissions.values()) {
      const { prepared } = stored;
      const profile = this.profiles.get(prepared.volunteerSlackUserId);

      if (stored.status !== "approved" || !profile) {
        continue;
      }

      if (
        filters.studentType !== "all" &&
        profile.studentType !== filters.studentType
      ) {
        continue;
      }

      if (
        filters.volunteerSlackUserIds &&
        !filters.volunteerSlackUserIds.includes(profile.slackUserId)
      ) {
        continue;
      }

      const category = this.categories.find(
        (candidate) => candidate.id === prepared.categoryId,
      );
      const event = this.events.find(
        (candidate) => candidate.id === prepared.eventId,
      );

      prepared.entries.forEach((entry, index) => {
        const entryId = stored.entryIds[index] ?? randomUUID();
        const sentAt = this.entrySentAt.get(entryId) ?? null;

        if (entry.yearId !== filters.yearId) {
          return;
        }

        if (filters.onlyUnsent && sentAt) {
          return;
        }

        rows.push({
          entryId,
          entryDate: entry.entryDate,
          hours: entry.hours,
          description: prepared.description,
          categoryName: category?.name ?? "Unknown",
          eventName: event?.name ?? null,
          ccrSentAt: sentAt,
          volunteerSlackUserId: profile.slackUserId,
          fullName: profile.fullName,
          email: profile.email,
          studentType: profile.studentType,
          utorid: profile.utorid,
          studentNumber: profile.studentNumber,
          yearLabel: year?.label ?? "Unknown",
        });
      });
    }

    return rows.sort((left, right) =>
      left.entryDate.localeCompare(right.entryDate),
    );
  }

  async createExport(input: ReportExportInput): Promise<ReportExport> {
    const created: ReportExport = {
      id: randomUUID(),
      generatedBySlackUserId: input.generatedBySlackUserId,
      yearId: input.yearId,
      kind: input.kind,
      entryCount: input.entryIds.length,
      totalHours: input.totalHours,
      generatedAt: new Date().toISOString(),
      markedSentAt: null,
      markedSentBySlackUserId: null,
    };
    this.exports.set(created.id, { export: created, entryIds: input.entryIds });

    return created;
  }

  async getExport(id: string): Promise<ReportExport | null> {
    return this.exports.get(id)?.export ?? null;
  }

  async markExportSent(
    id: string,
    markedBySlackUserId: string,
  ): Promise<MarkSentResult> {
    const stored = this.exports.get(id);

    if (!stored) {
      return { status: "not_found", markedEntries: 0 };
    }

    if (stored.export.markedSentAt) {
      return { status: "already_marked", markedEntries: 0 };
    }

    const now = new Date().toISOString();
    stored.export.markedSentAt = now;
    stored.export.markedSentBySlackUserId = markedBySlackUserId;

    let markedEntries = 0;
    for (const entryId of stored.entryIds) {
      if (!this.entrySentAt.has(entryId)) {
        this.entrySentAt.set(entryId, now);
        markedEntries += 1;
      }
    }

    return { status: "ok", markedEntries };
  }

  async listStaff(): Promise<VolunteerStaffMember[]> {
    return [...this.staff];
  }

  async upsertStaffMember(member: VolunteerStaffMember): Promise<void> {
    if (member.isPrimary) {
      this.staff.forEach((existing, index) => {
        if (existing.slackUserId !== member.slackUserId) {
          this.staff[index] = { ...existing, isPrimary: false };
        }
      });
    }

    const index = this.staff.findIndex(
      (existing) => existing.slackUserId === member.slackUserId,
    );

    const current = index >= 0 ? this.staff[index] : undefined;

    if (current) {
      // Mirrors the Neon upsert: a blank name keeps the existing one, but the
      // title is saved exactly as given (the edit form shows the current title,
      // so blank means the title was cleared).
      this.staff[index] = {
        ...member,
        displayName: member.displayName ?? current.displayName,
      };
    } else {
      this.staff.push(member);
    }
  }

  async removeStaffMember(slackUserId: string): Promise<boolean> {
    const index = this.staff.findIndex(
      (member) => member.slackUserId === slackUserId,
    );

    if (index < 0) {
      return false;
    }

    this.staff.splice(index, 1);
    return true;
  }

  async createCategory(
    name: string,
    requiresEvent: boolean,
  ): Promise<VolunteerCategory> {
    const category: VolunteerCategory = {
      id: randomUUID(),
      name,
      requiresEvent,
      isActive: true,
      sortOrder:
        Math.max(0, ...this.categories.map((existing) => existing.sortOrder)) +
        10,
    };
    this.categories.push(category);

    return category;
  }

  async updateCategory(
    id: string,
    changes: { name?: string; isActive?: boolean },
  ): Promise<VolunteerCategory | null> {
    const index = this.categories.findIndex((category) => category.id === id);
    const existing = this.categories[index];

    if (!existing) {
      return null;
    }

    const updated: VolunteerCategory = {
      ...existing,
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.isActive !== undefined ? { isActive: changes.isActive } : {}),
    };
    this.categories[index] = updated;

    return updated;
  }

  async createEvent(
    name: string,
    eventDate: string | null,
  ): Promise<VolunteerEvent> {
    const event: VolunteerEvent = {
      id: randomUUID(),
      name,
      eventDate,
      isActive: true,
    };
    this.events.push(event);

    return event;
  }

  async setEventActive(id: string, isActive: boolean): Promise<boolean> {
    const index = this.events.findIndex((event) => event.id === id);
    const existing = this.events[index];

    if (!existing) {
      return false;
    }

    this.events[index] = { ...existing, isActive };
    return true;
  }

  async createYear(
    label: string,
    startDate: string,
    endDate: string,
  ): Promise<VolunteerYear> {
    const year: VolunteerYear = {
      id: randomUUID(),
      label,
      startDate,
      endDate,
      isDefault: false,
    };
    this.years.push(year);

    return year;
  }

  async listYearStats(): Promise<YearStats[]> {
    const byYear = new Map<
      string,
      { volunteers: Set<string>; stats: YearStats }
    >();

    for (const stored of this.submissions.values()) {
      stored.prepared.entries.forEach((entry, index) => {
        const bucket =
          byYear.get(entry.yearId) ??
          {
            volunteers: new Set<string>(),
            stats: {
              yearId: entry.yearId,
              volunteers: 0,
              approvedHours: 0,
              pendingHours: 0,
              rejectedHours: 0,
              sentHours: 0,
            },
          };
        byYear.set(entry.yearId, bucket);
        bucket.volunteers.add(stored.prepared.volunteerSlackUserId);

        if (stored.status === "approved") {
          bucket.stats.approvedHours += entry.hours;

          if (this.entrySentAt.has(stored.entryIds[index] ?? "")) {
            bucket.stats.sentHours += entry.hours;
          }
        } else if (stored.status === "pending") {
          bucket.stats.pendingHours += entry.hours;
        } else {
          bucket.stats.rejectedHours += entry.hours;
        }
      });
    }

    return [...byYear.values()].map(({ volunteers, stats }) => ({
      ...stats,
      volunteers: volunteers.size,
    }));
  }

  async updateYear(
    id: string,
    label: string,
    startDate: string,
    endDate: string,
  ): Promise<UpdateYearResult> {
    const index = this.years.findIndex((year) => year.id === id);
    const existing = this.years[index];

    if (!existing) {
      return { status: "not_found" };
    }

    let outside = 0;

    for (const stored of this.submissions.values()) {
      for (const entry of stored.prepared.entries) {
        if (
          entry.yearId === id &&
          (entry.entryDate < startDate || entry.entryDate > endDate)
        ) {
          outside += 1;
        }
      }
    }

    if (outside > 0) {
      return { status: "entries_outside", count: outside };
    }

    const year = { ...existing, label, startDate, endDate };
    this.years[index] = year;

    return { status: "updated", year };
  }

  async deleteYear(id: string): Promise<DeleteYearResult> {
    const index = this.years.findIndex((year) => year.id === id);

    if (index < 0) {
      return "not_found";
    }

    const hasEntries = [...this.submissions.values()].some((stored) =>
      stored.prepared.entries.some((entry) => entry.yearId === id),
    );
    const hasExports = [...this.exports.values()].some(
      (stored) => stored.export.yearId === id,
    );

    if (hasEntries || hasExports) {
      return "in_use";
    }

    this.years.splice(index, 1);

    return "deleted";
  }

  async setDefaultYear(id: string | null): Promise<boolean> {
    if (id !== null && !this.years.some((year) => year.id === id)) {
      return false;
    }

    this.years.forEach((year, index) => {
      this.years[index] = { ...year, isDefault: year.id === id };
    });

    return true;
  }

  async updateEvent(
    id: string,
    name: string,
    eventDate: string | null,
  ): Promise<VolunteerEvent | null> {
    const index = this.events.findIndex((event) => event.id === id);
    const existing = this.events[index];

    if (!existing) {
      return null;
    }

    const event = { ...existing, name, eventDate };
    this.events[index] = event;

    return event;
  }

  private toSubmission(stored: StoredSubmission): VolunteerSubmission {
    const { prepared } = stored;
    const profile = this.profiles.get(prepared.volunteerSlackUserId);
    const category = this.categories.find(
      (candidate) => candidate.id === prepared.categoryId,
    );
    const event = this.events.find(
      (candidate) => candidate.id === prepared.eventId,
    );
    const entries: SubmissionEntry[] = prepared.entries.map(
      (entry, index) => ({
        id: stored.entryIds[index] ?? randomUUID(),
        entryDate: entry.entryDate,
        hours: entry.hours,
        yearId: entry.yearId,
        ccrSentAt:
          this.entrySentAt.get(stored.entryIds[index] ?? "") ?? null,
      }),
    );

    return {
      id: prepared.id,
      slackSubmissionId: prepared.slackSubmissionId,
      volunteerSlackUserId: prepared.volunteerSlackUserId,
      submittedBySlackUserId: prepared.submittedBySlackUserId,
      volunteerName: profile?.fullName ?? "Unknown",
      studentType: profile?.studentType ?? "high_school",
      categoryId: prepared.categoryId,
      categoryName: category?.name ?? "Unknown",
      eventId: prepared.eventId,
      eventName: event?.name ?? null,
      description: prepared.description,
      status: stored.status,
      decidedBySlackUserId: stored.decidedBySlackUserId,
      decidedAt: stored.decidedAt,
      decisionNote: stored.decisionNote,
      approvalChannelId: stored.approvalChannelId,
      approvalMessageTs: stored.approvalMessageTs,
      submittedAt: stored.submittedAt,
      editedBySlackUserId: stored.editedBySlackUserId,
      editedAt: stored.editedAt,
      version: stored.version,
      entries,
    };
  }
}
