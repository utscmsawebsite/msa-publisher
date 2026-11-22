import type { ReportEntry, ReportSort } from "../domain/volunteer-report.js";

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en", { sensitivity: "base" });
}

export function sortReportEntries(
  entries: ReportEntry[],
  sort: ReportSort,
): ReportEntry[] {
  const byName = (left: ReportEntry, right: ReportEntry) =>
    compareText(left.fullName, right.fullName) ||
    compareText(left.volunteerSlackUserId, right.volunteerSlackUserId);

  return [...entries].sort((left, right) =>
    sort === "name"
      ? byName(left, right) ||
        left.entryDate.localeCompare(right.entryDate) ||
        compareText(left.description, right.description)
      : left.entryDate.localeCompare(right.entryDate) ||
        byName(left, right) ||
        compareText(left.description, right.description),
  );
}

export function sumHours(entries: ReportEntry[]): number {
  return Number(
    entries.reduce((total, entry) => total + entry.hours, 0).toFixed(2),
  );
}

export function groupByVolunteer(
  entries: ReportEntry[],
): Map<string, ReportEntry[]> {
  const groups = new Map<string, ReportEntry[]>();

  for (const entry of entries) {
    const group = groups.get(entry.volunteerSlackUserId);

    if (group) {
      group.push(entry);
    } else {
      groups.set(entry.volunteerSlackUserId, [entry]);
    }
  }

  return groups;
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return slug || "report";
}
