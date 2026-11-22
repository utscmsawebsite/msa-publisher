import { studentTypeLabels } from "../domain/volunteer.js";
import type { ReportEntry } from "../domain/volunteer-report.js";

export interface CsvOptions {
  includeStudentDetails: boolean;
}

// Cells that start with these characters are treated as formulas by Excel and
// Sheets, and volunteers control the free-text fields, so they get a leading
// apostrophe.
function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function csvCell(value: string): string {
  const safe = neutralizeFormula(value);

  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function formatHours(hours: number): string {
  return String(Number(hours.toFixed(2)));
}

export function buildReportCsv(
  entries: ReportEntry[],
  options: CsvOptions,
): Buffer {
  const header = options.includeStudentDetails
    ? [
        "Volunteer Year",
        "Name",
        "Student Type",
        "UTORid",
        "Student Number",
        "Email",
        "Date",
        "Hours",
        "Category",
        "Event",
        "What was done",
      ]
    : [
        "Volunteer Year",
        "Name",
        "UTORid",
        "Student Number",
        "Email",
        "Date",
        "Hours",
        "Category",
        "Event",
        "What was done",
      ];

  const lines = [header.map(csvCell).join(",")];

  for (const entry of entries) {
    const cells = options.includeStudentDetails
      ? [
          entry.yearLabel,
          entry.fullName,
          studentTypeLabels[entry.studentType],
          entry.utorid ?? "",
          entry.studentNumber,
          entry.email,
          entry.entryDate,
          formatHours(entry.hours),
          entry.categoryName,
          entry.eventName ?? "",
          entry.description,
        ]
      : [
          entry.yearLabel,
          entry.fullName,
          entry.utorid ?? "",
          entry.studentNumber,
          entry.email,
          entry.entryDate,
          formatHours(entry.hours),
          entry.categoryName,
          entry.eventName ?? "",
          entry.description,
        ];

    lines.push(cells.map(csvCell).join(","));
  }

  // The BOM makes Excel read the file as UTF-8 so accented names survive.
  return Buffer.from(`﻿${lines.join("\r\n")}\r\n`, "utf8");
}
