import type { StudentType } from "./volunteer.js";

export type StudentTypeFilter = StudentType | "all";
export type ReportSort = "name" | "date";
export type ReportKind = "combined" | "letterhead";

export interface ReportFilters {
  yearId: string;
  studentType: StudentTypeFilter;
  onlyUnsent: boolean;
  sort: ReportSort;
  volunteerSlackUserIds: string[] | null;
}

export interface ReportEntry {
  entryId: string;
  entryDate: string;
  hours: number;
  description: string;
  categoryName: string;
  eventName: string | null;
  ccrSentAt: string | null;
  volunteerSlackUserId: string;
  fullName: string;
  email: string;
  studentType: StudentType;
  utorid: string | null;
  studentNumber: string;
  yearLabel: string;
}

export interface ReportExportInput {
  generatedBySlackUserId: string;
  yearId: string;
  kind: ReportKind;
  filters: ReportFilters;
  entryIds: string[];
  totalHours: number;
}

export interface ReportExport {
  id: string;
  generatedBySlackUserId: string;
  yearId: string;
  kind: ReportKind;
  entryCount: number;
  totalHours: number;
  generatedAt: string;
  markedSentAt: string | null;
  markedSentBySlackUserId: string | null;
}

export interface MarkSentResult {
  status: "ok" | "already_marked" | "not_found";
  markedEntries: number;
}
