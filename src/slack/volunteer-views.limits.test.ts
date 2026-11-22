import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  VolunteerProfile,
  VolunteerSubmission,
} from "../domain/volunteer.js";
import type { AdminData } from "../services/volunteer-admin.service.js";
import { MAX_ENTRIES_PER_SUBMISSION } from "../services/volunteer.service.js";
import {
  buildCategoriesView,
  buildCategoryFormView,
  buildEventFormView,
  buildEventsView,
  buildLinkFormView,
  buildStaffFormView,
  buildStaffView,
  buildYearFormView,
  buildYearView,
  buildYearsView,
  MAX_ROWS,
  type AdminViewContext,
} from "./volunteer-admin-views.js";
import {
  buildAdminHomeView,
  buildExecHomeView,
  buildMemberHomeView,
} from "./volunteer-hub-views.js";
import { buildReportFormView } from "./volunteer-report-handlers.js";
import { withBack } from "./volunteer-hub-views.js";
import { buildPendingView } from "./volunteer-pending-views.js";
import {
  checkView,
  isObject,
  text,
  type Json,
} from "./volunteer-view-limits.testkit.js";
import {
  buildRequestsView,
  requestTotals,
} from "./volunteer-request-views.js";
import {
  buildApprovalCard,
  buildBehalfPickView,
  buildDeletedCard,
  buildHoursFormView,
  buildLoadingView,
  buildMessageView,
  buildProfileFormView,
  buildRecordsPickView,
  buildRejectReasonView,
  buildStudentTypeView,
  emptyHoursFormValues,
  valuesFromSubmission,
} from "./volunteer-views.js";

// ---- fixtures: deliberately large, long and awkward ----

const LONG = "Ünïcödé ".repeat(30).trim(); // ~240 chars

const profile: VolunteerProfile = {
  slackUserId: "UABC123456",
  studentType: "uoft",
  firstName: "A".repeat(60),
  lastName: "B".repeat(60),
  fullName: `${"A".repeat(60)} ${"B".repeat(60)}`,
  preferredEmail: `${"p".repeat(100)}@example.com`,
  email: `${"e".repeat(100)}@mail.utoronto.ca`,
  utorid: "u".repeat(16),
  studentNumber: "1".repeat(10),
};

const formData = {
  categories: Array.from({ length: 120 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name: `${LONG} category ${index}`,
    requiresEvent: index % 2 === 0,
    isActive: true,
    sortOrder: index,
  })),
  events: Array.from({ length: 150 }, (_, index) => ({
    id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name: `${LONG} event ${index}`,
    eventDate: index % 2 === 0 ? "2026-11-12" : null,
    isActive: true,
  })),
  years: Array.from({ length: 120 }, (_, index) => ({
    id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    label: `${LONG} year ${index}`,
    startDate: "2026-09-01",
    endDate: "2027-08-31",
  })),
};

function request(index: number, overrides: Partial<VolunteerSubmission> = {}): VolunteerSubmission {
  const category = formData.categories[0];

  return {
    id: `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    slackSubmissionId: `V${index}`,
    volunteerSlackUserId: "UABC123456",
    submittedBySlackUserId: "UEXEC00001",
    volunteerName: profile.fullName,
    studentType: "uoft",
    categoryId: category?.id ?? "c",
    categoryName: `${LONG} category 0`,
    eventId: formData.events[0]?.id ?? null,
    eventName: `${LONG} event 0`,
    description: "d".repeat(1500),
    status: "pending",
    decidedBySlackUserId: null,
    decidedAt: null,
    decisionNote: null,
    approvalChannelId: "C123",
    approvalMessageTs: "1.2",
    submittedAt: "2026-11-12 10:00:00+00",
    editedBySlackUserId: "UEXEC00001",
    editedAt: "2026-11-13 10:00:00+00",
    version: 1,
    entries: Array.from({ length: MAX_ENTRIES_PER_SUBMISSION }, (_, entry) => ({
      id: `40000000-0000-4000-8000-${String(entry).padStart(12, "0")}`,
      entryDate: `2026-11-${String(entry + 1).padStart(2, "0")}`,
      hours: entry % 2 === 0 ? 24 : 0.25,
      yearId: "y",
      ccrSentAt: null,
    })),
    ...overrides,
  };
}

const target = { id: "ext_0123456789abcdef0123456789abcdef", name: profile.fullName };

describe("every view respects Slack's limits, even with worst-case data", () => {
  const views: Array<[string, Json, "modal" | "message"]> = [];
  const modal = (name: string, view: unknown) =>
    views.push([name, view as Json, "modal"]);
  const message = (name: string, view: unknown) =>
    views.push([name, view as Json, "message"]);

  modal("loading", buildLoadingView("A very long title that exceeds the limit"));
  modal("message", buildMessageView("Log hours for someone", "x".repeat(2900)));
  modal("behalf pick", buildBehalfPickView());
  modal("records pick", buildRecordsPickView());
  modal("reject reason", buildRejectReasonView("s".repeat(36)));

  for (const type of ["uoft", "other_university", "high_school"] as const) {
    modal(`student type (${type}, edit, prefilled)`, buildStudentTypeView("edit", profile));
    modal(`student type (${type}, for someone)`, buildStudentTypeView("onboard", null, target));
    modal(`profile form (${type}, prefilled)`, buildProfileFormView("edit", type, { ...profile, studentType: type }));
    modal(`profile form (${type}, for someone)`, buildProfileFormView("onboard", type, null, target));
  }

  modal("hours form (new, empty)", buildHoursFormView(formData, emptyHoursFormValues()));
  modal("hours form (new, for someone)", buildHoursFormView(formData, emptyHoursFormValues(), target));

  const full = request(1);
  for (const asExec of [false, true]) {
    modal(
      `hours form (edit, 15 rows, asExec=${asExec})`,
      buildHoursFormView(
        formData,
        valuesFromSubmission(full),
        asExec ? target : null,
        { submissionId: full.id, asExec },
      ),
    );
  }

  const requests = Array.from({ length: 150 }, (_, index) => request(index));
  const cards = (list: VolunteerSubmission[]) =>
    buildRequestsView({
      title: "Volunteer requests",
      heading: `*${LONG}*\n${requestTotals(list)}`,
      requests: list,
      back: "admin",
      editBack: `records:${"x".repeat(40)}`,
      emptyText: LONG,
      notice: `⚠️ ${LONG}`,
    });
  modal("request cards (150 requests)", cards(requests));
  modal(
    "pending queue (25 long requests)",
    buildPendingView({ requests: requests.slice(0, 25), total: 9999, canApprove: true, back: "admin", notice: `⚠️ ${LONG}` }),
  );
  modal(
    "pending queue (read-only)",
    buildPendingView({ requests: requests.slice(0, 25), total: 25, canApprove: false, back: "exec" }),
  );
  modal("pending queue (empty)", buildPendingView({ requests: [], total: 0, canApprove: true, back: "exec" }));
  modal("reject reason from the queue + Back", withBack(buildRejectReasonView("s".repeat(36), 4, "admin"), "pending:admin"));
  modal("request cards (none)", cards([]));

  modal("CCR report form", buildReportFormView(formData.years));
  modal("letters form", buildReportFormView(formData.years, null, "letterhead"));

  const adminData: AdminData = {
    categories: formData.categories,
    events: formData.events,
    years: formData.years,
    staff: Array.from({ length: 80 }, (_, index) => ({
      slackUserId: `U${String(index).padStart(9, "0")}`,
      displayName: LONG,
      title: LONG.slice(0, 80),
      canApprove: true,
      canManage: index % 2 === 0,
      isPrimary: index === 0,
    })),
    yearStats: formData.years.map((year) => ({
      yearId: year.id,
      volunteers: 99999,
      approvedHours: 99999.5,
      pendingHours: 99999.5,
      rejectedHours: 99999.5,
      sentHours: 99999.5,
    })),
  };
  const firstYear = formData.years[0];
  const firstCategory = formData.categories[0];
  const firstEvent = formData.events[0];
  const firstStaff = adminData.staff[0];

  if (!firstYear || !firstCategory || !firstEvent || !firstStaff) {
    throw new Error("fixtures are empty");
  }

  for (const canChangeStaff of [true, false]) {
    const adminContext: AdminViewContext = {
      data: adminData,
      today: "2026-11-15",
      canChangeStaff,
    };
    const warning = `⚠️ ${LONG}`;
    const tag = `staffAdmin=${canChangeStaff}`;

    modal(`admin home (${tag})`, buildAdminHomeView(adminContext, warning));
    modal(`years (${tag}, 120 years)`, buildYearsView(adminContext, warning));
    modal(`year page (${tag}, 75 events)`, buildYearView(adminContext, firstYear, warning));
    modal(`staff (${tag}, 80 people)`, buildStaffView(adminContext, warning));
    modal(`categories (${tag}, 120)`, buildCategoriesView(adminContext, warning));
    modal(`events (${tag}, 150)`, buildEventsView(adminContext, warning));
  }

  modal("year form (new)", buildYearFormView(null, undefined, "years"));
  modal("year form (edit, empty year)", buildYearFormView(firstYear, undefined, `year:${firstYear.id}`));
  modal(
    "year form (edit, with hours)",
    buildYearFormView(firstYear, adminData.yearStats[0], `year:${firstYear.id}`),
  );
  modal("staff form (new)", buildStaffFormView(null, "staff"));
  modal("staff form (edit, all permissions)", buildStaffFormView(firstStaff, "staff"));
  modal(
    "staff form (edit, no permissions)",
    buildStaffFormView({ ...firstStaff, canApprove: false, canManage: false, isPrimary: false }, "staff"),
  );
  modal("category form (new)", buildCategoryFormView(null, "categories"));
  modal("category form (edit)", buildCategoryFormView(firstCategory, "categories"));
  modal("event form (new)", buildEventFormView(null, "events"));
  modal("event form (new, in a year)", buildEventFormView(null, `year:${firstYear.id}`, "2026-11-15"));
  modal("event form (edit)", buildEventFormView(firstEvent, `year:${firstYear.id}`));
  modal("link form", buildLinkFormView("home"));

  const myHours = {
    rows: Array.from({ length: 500 }, (_, index) => ({
      entryDate: "2026-11-12",
      hours: 24,
      status: (["pending", "approved", "rejected"] as const)[index % 3] ?? "pending",
      categoryName: LONG,
      eventName: LONG,
      description: "d".repeat(1500),
      decisionNote: "n".repeat(500),
      enteredByStaff: index % 2 === 0,
    })),
    approvedHours: 9999,
    pendingHours: 9999,
    rejectedHours: 9999,
  };
  modal("member home (plain member)", buildMemberHomeView(myHours, { isExec: false, isAdmin: false }));
  modal("member home (admin)", buildMemberHomeView(myHours, { isExec: true, isAdmin: true }));
  modal("exec home", buildExecHomeView());
  // Every screen reached from a home gets a ← Back block on top: it must still fit.
  modal("hours form + Back", withBack(buildHoursFormView(formData, emptyHoursFormValues()), "member"));
  modal(
    "edit form with 15 dates + Back",
    withBack(
      buildHoursFormView(formData, valuesFromSubmission(request(2)), null, { submissionId: "s", asExec: true }),
      `records:${"x".repeat(40)}`,
    ),
  );
  modal("CCR report form + Back", withBack(buildReportFormView(formData.years), "exec"));
  modal("letters form + Back", withBack(buildReportFormView(formData.years, null, "letterhead"), "exec"));
  modal("behalf pick + Back", withBack(buildBehalfPickView(), "admin"));
  modal("records pick + Back", withBack(buildRecordsPickView(), "admin"));
  modal("student type + Back", withBack(buildStudentTypeView("onboard", null), "member"));
  modal("message + Back", withBack(buildMessageView("Log hours", "x".repeat(2900)), "admin"));
    message("approval card (pending, 15 dates)", buildApprovalCard(request(2), "UPRIMARY01"));
  message(
    "approval card (approved, no Slack volunteer)",
    buildApprovalCard(
      request(3, {
        status: "approved",
        volunteerSlackUserId: target.id,
        decidedBySlackUserId: "UEXEC00001",
        decidedAt: "2026-11-13 10:00:00+00",
        description: "<b>&</b> " + "d".repeat(2400),
      }),
      null,
    ),
  );
  message("approval card (disapproved)", buildApprovalCard(request(4, { status: "rejected", decidedBySlackUserId: "UAPPROVER1", decidedAt: "2026-11-13 10:00:00+00", decisionNote: "n".repeat(500) }), null));
  message("deleted card", buildDeletedCard(request(5), "UEXEC00001"));

  for (const [name, view, kind] of views) {
    it(name, () => {
      assert.deepEqual(checkView(view, name, kind), []);
    });
  }

  it("covers the views it claims to", () => {
    assert.ok(views.length >= 68, `only ${views.length} views checked`);
  });
});

describe("the limits checker itself", () => {
  it("catches the mistakes it is meant to catch", () => {
    const bad = {
      type: "modal",
      title: { type: "plain_text", text: "x".repeat(25) },
      private_metadata: "m".repeat(3001),
      blocks: [
        {
          type: "input",
          block_id: "dup",
          label: { type: "plain_text", text: "Label" },
          element: {
            type: "static_select",
            action_id: "a",
            options: [
              { text: { type: "plain_text", text: "y".repeat(76) }, value: "v" },
              { text: { type: "plain_text", text: "ok" }, value: "w", description: { type: "plain_text", text: "z".repeat(76) } },
            ],
            initial_option: { text: { type: "plain_text", text: "ok" }, value: "missing" },
          },
        },
        { type: "section", block_id: "dup", text: { type: "mrkdwn", text: "hi" } },
      ],
    };
    const problems = checkView(bad, "bad", "modal").join("\n");

    for (const expected of [
      "title over 24",
      "private_metadata is 3001",
      "option text over 75",
      "option description over 75",
      "initial_option",
      "duplicate block_id",
    ]) {
      assert.ok(problems.includes(expected), `did not catch: ${expected}\n${problems}`);
    }
  });
});

describe("long lists are trimmed sensibly", () => {
  const find = (view: unknown, predicate: (block: Json) => boolean) =>
    ((view as Json).blocks as Json[]).find(predicate);

  it("keeps the request's own category in an edit form when there are over 100 categories", () => {
    const chosen = formData.categories[110];
    assert.ok(chosen);

    const view = buildHoursFormView(
      formData,
      { ...emptyHoursFormValues(), categoryId: chosen.id },
      null,
      { submissionId: "s", asExec: false },
    );
    const select = (find(view, (block) => block.block_id === "vol_category") as Json)
      .element as Json;
    const options = select.options as Json[];

    assert.equal(options.length, 100);
    assert.ok(options.some((option) => option.value === chosen.id));
    assert.equal((select.initial_option as Json).value, chosen.id);
  });

  const listContext = (years: typeof formData.years): AdminViewContext => ({
    data: { categories: [], events: [], staff: [], years, yearStats: [] },
    today: "2026-11-15",
    canChangeStaff: true,
  });
  const sectionTexts = (view: unknown): string[] =>
    ((view as Json).blocks as Json[])
      .filter((block) => block.type === "section")
      .map((block) => text(block.text));

  it("shows the newest years first, and how many were left out, when the list is too long", () => {
    const years = formData.years.map((year, index) => ({
      ...year,
      label: `Year ${index}`,
      startDate: `${2000 + index}-09-01`,
      endDate: `${2000 + index + 1}-08-31`,
    }));
    const body = sectionTexts(buildYearsView(listContext(years))).join("\n");

    assert.ok(body.includes("Year 119"), "the newest year must be shown");
    assert.ok(!body.includes("*Year 0*"), "the oldest year is the one left out");
    assert.equal((body.match(/\*Year \d+\*/g) ?? []).length, MAX_ROWS);

    const notes = JSON.stringify(buildYearsView(listContext(years)).blocks);

    assert.ok(notes.includes(`Showing ${MAX_ROWS} of 120 years`));
  });

  it("lists every year, with no note, when they fit", () => {
    const years = formData.years.slice(0, 3).map((year, index) => ({
      ...year,
      label: `Year ${index}`,
    }));
    const view = buildYearsView(listContext(years));

    assert.ok(!JSON.stringify(view).includes("Showing"));
    assert.equal(sectionTexts(view).filter((line) => line.includes("*Year ")).length, 3);
  });
});

describe("the categories screens explain the event dropdown", () => {
  const category = (name: string, requiresEvent: boolean) => ({
    id: `30000000-0000-4000-8000-${requiresEvent ? "000000000001" : "000000000002"}`,
    name,
    requiresEvent,
    isActive: true,
    sortOrder: requiresEvent ? 2 : 1,
  });
  const event = (name: string, isActive: boolean) => ({
    id: `40000000-0000-4000-8000-${String(name.length).padStart(12, "0")}${isActive ? "1" : "0"}`.slice(0, 36),
    name,
    eventDate: "2026-11-20",
    isActive,
  });
  const contextWith = (events: ReturnType<typeof event>[]): AdminViewContext => ({
    data: {
      categories: [category("General", false), category("Specific Event", true)],
      events,
      staff: [],
      years: [],
      yearStats: [],
    },
    today: "2026-11-20",
    canChangeStaff: true,
  });
  const all = (view: unknown): string => JSON.stringify((view as Json).blocks);

  it("says how many active events an event-style category shows, and counts only active ones", () => {
    const view = buildCategoriesView(
      contextWith([event("Fall Iftar", true), event("Old Bake Sale", false)]),
    );

    assert.ok(all(view).includes("volunteers pick from 1 active event"));
    assert.ok(!all(view).includes("1 active events"));
    assert.ok(!all(view).includes("needs an event"));
  });

  it("warns when an event-style category has no active events to offer", () => {
    const view = buildCategoriesView(contextWith([event("Old Bake Sale", false)]));

    assert.ok(all(view).includes("no active events yet"));
  });

  it("the edit form names the events volunteers will see, and says the setting is fixed", () => {
    const active = [event("Fall Iftar", true), event("Welcome BBQ", true)];
    const form = buildCategoryFormView(category("Specific Event", true), "categories", active);

    assert.ok(all(form).includes("Fall Iftar"));
    assert.ok(all(form).includes("Welcome BBQ"));
    assert.ok(all(form).includes("can't be changed"));

    const plain = buildCategoryFormView(category("General", false), "categories", active);

    assert.ok(all(plain).includes("don't pick an event"));
    assert.ok(!all(plain).includes("Fall Iftar"));
  });

  it("the add form has the checkbox and no explanation yet", () => {
    const form = buildCategoryFormView(null, "categories");

    assert.ok(all(form).includes("Volunteers must pick an event"));
    assert.ok(!all(form).includes("can't be changed"));
  });
});
