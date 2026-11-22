import type {
  MarkSentResult,
  ReportExport,
  ReportFilters,
} from "../domain/volunteer-report.js";
import type { VolunteerProfile, VolunteerYear } from "../domain/volunteer.js";
import type { VolunteerRepository } from "../repositories/volunteer.repository.js";
import { buildReportCsv } from "../volunteer-reports/csv.js";
import {
  buildCombinedReportPdf,
  buildLetterheadPdf,
  type LetterheadConfig,
} from "../volunteer-reports/pdf.js";
import {
  groupByVolunteer,
  slugify,
  sortReportEntries,
  sumHours,
} from "../volunteer-reports/sorting.js";
import { todayInToronto } from "./volunteer.service.js";

export interface ReportFile {
  filename: string;
  content: Uint8Array;
}

export interface GeneratedReport {
  export: ReportExport;
  files: ReportFile[];
  entryCount: number;
  volunteerCount: number;
  totalHours: number;
  skippedVolunteers: string[];
}

export type GenerateReportResult =
  | { status: "ok"; report: GeneratedReport }
  | { status: "not_authorized" }
  | { status: "no_year" }
  | { status: "no_signatory" }
  | { status: "empty" };

export type MarkSentOutcome =
  | { status: "not_authorized" }
  | { status: "done"; result: MarkSentResult };

export class VolunteerReportService {
  constructor(
    private readonly repository: VolunteerRepository,
    private readonly letterhead: LetterheadConfig,
    private readonly adminUserIds: ReadonlySet<string> = new Set(),
  ) {}

  get organizationName(): string {
    return this.letterhead.organizationName;
  }

  /** Execs (staff who can approve or manage) and admins can use reports. */
  async canUseReports(slackUserId: string): Promise<boolean> {
    if (this.adminUserIds.has(slackUserId)) {
      return true;
    }

    const staff = await this.repository.getStaffMember(slackUserId);

    return Boolean(staff?.canApprove || staff?.canManage);
  }

  /** Finds volunteers by name, UTORid or email for the report picker. */
  async searchVolunteers(
    requestedBySlackUserId: string,
    query: string,
  ): Promise<VolunteerProfile[]> {
    const text = query.trim().slice(0, 60);

    if (!text || !(await this.canUseReports(requestedBySlackUserId))) {
      return [];
    }

    return this.repository.searchProfiles(text, 20);
  }

  async listYears(): Promise<VolunteerYear[]> {
    return this.repository.listYears();
  }

  async generateCombined(
    requestedBySlackUserId: string,
    filters: ReportFilters,
  ): Promise<GenerateReportResult> {
    if (!(await this.canUseReports(requestedBySlackUserId))) {
      return { status: "not_authorized" };
    }

    const year = await this.findYear(filters.yearId);

    if (!year) {
      return { status: "no_year" };
    }

    const entries = sortReportEntries(
      await this.repository.listReportEntries(filters),
      filters.sort,
    );

    if (entries.length === 0) {
      return { status: "empty" };
    }

    const generatedOn = todayInToronto();
    const baseName = `volunteer-hours-${slugify(year.label)}-by-${filters.sort}-${generatedOn}`;
    const pdf = await buildCombinedReportPdf({
      entries,
      sort: filters.sort,
      yearLabel: year.label,
      studentType: filters.studentType,
      onlyUnsent: filters.onlyUnsent,
      generatedOn,
      organizationName: this.letterhead.organizationName,
    });
    const csv = buildReportCsv(entries, {
      includeStudentDetails: filters.studentType !== "uoft",
    });
    const totalHours = sumHours(entries);
    const volunteerCount = groupByVolunteer(entries).size;
    const created = await this.repository.createExport({
      generatedBySlackUserId: requestedBySlackUserId,
      yearId: filters.yearId,
      kind: "combined",
      filters,
      entryIds: entries.map((entry) => entry.entryId),
      totalHours,
    });

    return {
      status: "ok",
      report: {
        export: created,
        files: [
          { filename: `${baseName}.csv`, content: csv },
          { filename: `${baseName}.pdf`, content: pdf },
        ],
        entryCount: entries.length,
        volunteerCount,
        totalHours,
        skippedVolunteers: [],
      },
    };
  }

  async generateLetterheads(
    requestedBySlackUserId: string,
    filters: ReportFilters,
    selectedNames: ReadonlyMap<string, string>,
  ): Promise<GenerateReportResult> {
    const staff = await this.repository.getStaffMember(requestedBySlackUserId);

    if (!staff?.canApprove && !staff?.canManage) {
      return { status: "not_authorized" };
    }

    // Letters are signed by whoever generates them, using the name and title
    // on their staff record, so a letter never goes out unsigned or untitled.
    const signatoryName = staff.displayName?.trim();
    const signatoryTitle = staff.title?.trim();

    if (!signatoryName || !signatoryTitle) {
      return { status: "no_signatory" };
    }

    const year = await this.findYear(filters.yearId);

    if (!year) {
      return { status: "no_year" };
    }

    // A letter lists everything the volunteer has had approved, whether or not
    // it was already sent to CCR.
    const letterFilters: ReportFilters = {
      ...filters,
      onlyUnsent: false,
      sort: "date",
    };
    const entries = await this.repository.listReportEntries(letterFilters);
    const byVolunteer = groupByVolunteer(entries);

    if (byVolunteer.size === 0) {
      return { status: "empty" };
    }

    const generatedOn = todayInToronto();
    const files: ReportFile[] = [];
    const usedNames = new Set<string>();

    for (const group of byVolunteer.values()) {
      const sorted = sortReportEntries(group, "date");
      const first = sorted[0];

      if (!first) {
        continue;
      }

      let filename = `letter-${slugify(first.fullName)}-${slugify(year.label)}.pdf`;
      if (usedNames.has(filename)) {
        filename = `letter-${slugify(first.fullName)}-${first.volunteerSlackUserId.toLowerCase()}-${slugify(year.label)}.pdf`;
      }
      usedNames.add(filename);

      files.push({
        filename,
        content: await buildLetterheadPdf({
          entries: sorted,
          yearLabel: year.label,
          generatedOn,
          config: this.letterhead,
          signatory: { name: signatoryName, title: signatoryTitle },
        }),
      });
    }

    const skippedVolunteers = [...selectedNames.entries()]
      .filter(([slackUserId]) => !byVolunteer.has(slackUserId))
      .map(([, label]) => label);
    const created = await this.repository.createExport({
      generatedBySlackUserId: requestedBySlackUserId,
      yearId: filters.yearId,
      kind: "letterhead",
      filters: letterFilters,
      entryIds: entries.map((entry) => entry.entryId),
      totalHours: sumHours(entries),
    });

    return {
      status: "ok",
      report: {
        export: created,
        files,
        entryCount: entries.length,
        volunteerCount: byVolunteer.size,
        totalHours: sumHours(entries),
        skippedVolunteers,
      },
    };
  }

  async markSent(
    exportId: string,
    slackUserId: string,
  ): Promise<MarkSentOutcome> {
    if (!(await this.canUseReports(slackUserId))) {
      return { status: "not_authorized" };
    }

    return {
      status: "done",
      result: await this.repository.markExportSent(exportId, slackUserId),
    };
  }

  private async findYear(yearId: string): Promise<VolunteerYear | null> {
    const years = await this.repository.listYears();

    return years.find((year) => year.id === yearId) ?? null;
  }
}
