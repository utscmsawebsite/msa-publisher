import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReportFormView } from "./volunteer-report-handlers.js";

const years = [
  { id: "y1", label: "2025/26", startDate: "2025-09-01", endDate: "2026-03-15" },
  { id: "y2", label: "2026/27", startDate: "2026-09-01", endDate: "2027-03-15" },
];

const labels = (view: { blocks?: unknown }) =>
  ((view.blocks ?? []) as Array<{ type: string; label?: { text: string }; optional?: boolean }>)
    .filter((block) => block.type === "input")
    .map((block) => `${block.label?.text}${block.optional ? " (optional)" : ""}`);

describe("the two report forms", () => {
  it("the CCR report asks for year, students, entries, sort, and optionally which volunteers", () => {
    const view = buildReportFormView(years);

    assert.equal(view.title?.text, "CCR report");
    assert.deepEqual(labels(view), [
      "Volunteer year",
      "Students",
      "Entries",
      "Sort",
      "Only these volunteers (optional)",
    ]);
    assert.deepEqual(JSON.parse(view.private_metadata ?? "{}"), { mode: "combined" });
  });

  it("the letters form asks only for a year and which volunteers, and requires at least one", () => {
    const view = buildReportFormView(years, null, "letterhead");

    assert.equal(view.title?.text, "Volunteer letters");
    assert.deepEqual(labels(view), ["Volunteer year", "Volunteers"]);
    assert.deepEqual(JSON.parse(view.private_metadata ?? "{}"), { mode: "letterhead" });
  });

  it("starts on the chosen year, in either form", () => {
    for (const mode of ["combined", "letterhead"] as const) {
      const year = (buildReportFormView(years, "y1", mode).blocks as Array<{ block_id?: string; element?: { initial_option?: { value: string } } }>).find(
        (block) => block.block_id === "vol_r_year",
      );

      assert.equal(year?.element?.initial_option?.value, "y1", mode);
    }
  });
});
