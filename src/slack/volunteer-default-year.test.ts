import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickDefaultYear, type VolunteerYear } from "../domain/volunteer.js";
import { buildAdminHomeView } from "./volunteer-hub-views.js";
import {
  buildYearFormView,
  buildYearView,
  buildYearsView,
  setupSummary,
  type AdminViewContext,
} from "./volunteer-admin-views.js";
import { checkView, isObject, text } from "./volunteer-view-limits.testkit.js";

const year = (id: string, start: string, end: string, isDefault = false): VolunteerYear => ({
  id,
  label: `Year ${id}`,
  startDate: start,
  endDate: end,
  isDefault,
});

const OLD = year("old", "2024-09-01", "2025-03-15");
const CURRENT = year("cur", "2026-09-01", "2027-03-15");
const NEXT = year("next", "2027-09-01", "2028-03-15");
const TODAY = "2026-11-23";

const contextOf = (years: VolunteerYear[]): AdminViewContext => ({
  data: { categories: [], events: [], staff: [], years, yearStats: [] },
  today: TODAY,
  canChangeStaff: true,
});

/** Every section's text on a screen, one per block. */
const sectionTexts = (view: { blocks?: unknown }): string[] =>
  ((view.blocks ?? []) as unknown[])
    .filter(isObject)
    .filter((block) => block.type === "section")
    .map((block) => text(block.text));

const checkbox = (view: { blocks?: unknown }) =>
  ((view.blocks ?? []) as Array<Record<string, unknown>>)
    .map((block) => block.element as Record<string, unknown> | undefined)
    .find((element) => element?.type === "checkboxes") as
    | { options: Array<{ value: string; description?: { text: string } }>; initial_options?: Array<{ value: string }> }
    | undefined;

describe("which year a form starts on", () => {
  it("prefers the default year over the year that contains today", () => {
    assert.equal(pickDefaultYear([OLD, CURRENT, { ...NEXT, isDefault: true }], TODAY)?.id, "next");
  });

  it("falls back to the year containing today when no year is the default", () => {
    assert.equal(pickDefaultYear([OLD, CURRENT, NEXT], TODAY)?.id, "cur");
  });

  it("falls back to the latest year when none contains today", () => {
    assert.equal(pickDefaultYear([OLD, NEXT], TODAY)?.id, "next");
  });

  it("is null only when there are no years", () => {
    assert.equal(pickDefaultYear([], TODAY), null);
  });
});

describe("the default-year checkbox on the year form", () => {
  it("is ticked for a first year, so a new setup needs no extra step", () => {
    const view = buildYearFormView(null, undefined, "years", false);

    assert.deepEqual(checkbox(view)?.initial_options?.map((o) => o.value), ["default"]);
  });

  it("is not ticked for a new year when another year is already the default", () => {
    const view = buildYearFormView(null, undefined, "years", true);

    assert.equal(checkbox(view)?.initial_options, undefined);
    assert.equal(checkbox(view)?.options[0]?.value, "default");
  });

  it("shows the current choice when editing", () => {
    const asDefault = buildYearFormView({ ...CURRENT, isDefault: true }, undefined, "years");
    const notDefault = buildYearFormView(CURRENT, undefined, "years");

    assert.deepEqual(checkbox(asDefault)?.initial_options?.map((o) => o.value), ["default"]);
    assert.equal(checkbox(notDefault)?.initial_options, undefined);
  });

  it("explains itself in a few words and stays within Slack's limits", () => {
    for (const view of [
      buildYearFormView(null, undefined, "years", false),
      buildYearFormView({ ...CURRENT, isDefault: true }, undefined, "years"),
    ]) {
      const description = checkbox(view)?.options[0]?.description?.text ?? "";

      assert.ok(description.length > 0 && description.length <= 75, description);
      assert.deepEqual(checkView(view as never, "year form", "modal"), []);
    }
  });
});

describe("showing which year is the default", () => {
  const years = [OLD, { ...CURRENT, isDefault: true }, NEXT];

  it("tags only the default year in the Years list", () => {
    const rows = sectionTexts(buildYearsView(contextOf(years)));

    assert.equal(rows.filter((row) => row.includes("★ Default")).length, 1);
    assert.ok(rows.some((row) => row.includes("Year cur") && row.includes("★ Default")));
  });

  it("tags the default year on its own page", () => {
    assert.ok(sectionTexts(buildYearView(contextOf(years), years[1]!)).join("\n").includes("★ Default"));
    assert.ok(!sectionTexts(buildYearView(contextOf(years), OLD)).join("\n").includes("★ Default"));
  });

  it("names the default year in the admin home summary, else the current year", () => {
    assert.match(setupSummary(contextOf(years)), /Default year: Year cur/);
    assert.match(setupSummary(contextOf([OLD, CURRENT, NEXT])), /Current year: Year cur/);
    assert.match(setupSummary(contextOf([OLD])), /No current year/);
  });

  it("keeps the admin home within Slack's limits", () => {
    assert.deepEqual(checkView(buildAdminHomeView(contextOf(years)) as never, "admin home", "modal"), []);
  });
});
