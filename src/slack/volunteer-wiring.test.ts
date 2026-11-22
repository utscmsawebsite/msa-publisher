import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { App } from "@slack/bolt";
import type { VolunteerServices } from "../volunteer-application.js";
import { createVolunteerSlackApp } from "./volunteer-app.js";
import {
  buildAdminHomeView,
  buildDoneView,
  buildExecHomeView,
  buildMemberHomeView,
} from "./volunteer-hub-views.js";
import * as adminViews from "./volunteer-admin-views.js";
import { buildPendingView } from "./volunteer-pending-views.js";
import { buildReportFormView } from "./volunteer-report-handlers.js";
import { buildRequestsView } from "./volunteer-request-views.js";
import * as views from "./volunteer-views.js";

/**
 * A screen with a button, a search box or a form that nothing is listening to
 * fails silently in Slack: the click does nothing. This registers the real
 * app, builds every screen, and checks each interactive element and each form
 * has a handler.
 */
const registered = {
  command: new Set<string>(),
  action: [] as Array<string | RegExp>,
  view: new Set<string>(),
  options: [] as Array<string | RegExp>,
};
const patched = ["command", "action", "view", "options"] as const;
const originals = new Map<string, unknown>();

const profile = { slackUserId: "U1", studentType: "uoft", firstName: "A", lastName: "B", fullName: "A B", preferredEmail: "a@b.c", email: "a@b.c", utorid: "ab", studentNumber: "100000001" } as never;
const formData = {
  categories: [{ id: "c1", name: "General", requiresEvent: false, isActive: true, sortOrder: 1 }],
  events: [{ id: "e1", name: "Iftar", eventDate: "2026-11-20", isActive: true }],
  years: [{ id: "y1", label: "2026/27", startDate: "2026-09-01", endDate: "2027-03-15" }],
};
const submission = {
  id: "s1", slackSubmissionId: "V1", volunteerSlackUserId: "U1", volunteerName: "A B", submittedBySlackUserId: "U1",
  status: "pending", version: 0, categoryName: "General", eventId: null, eventName: null, description: "x",
  entries: [{ id: "n1", entryDate: "2026-11-12", hours: 2, yearId: "y1", ccrSentAt: null }],
  decidedBySlackUserId: null, decidedAt: null, decisionNote: null, approvalChannelId: null, approvalMessageTs: null,
  submittedAt: "2026-11-12 10:00:00+00", editedBySlackUserId: null, editedAt: null,
} as never;
const staff = { slackUserId: "U1", displayName: "A", title: "T", canApprove: true, canManage: true, isPrimary: true };
const context = {
  data: { categories: formData.categories, events: formData.events, years: formData.years, staff: [staff], yearStats: [] },
  today: "2026-11-15",
  canChangeStaff: true,
} as never;

function allScreens(): unknown[] {
  return [
    views.buildBehalfPickView(), views.buildStudentTypeView("onboard", null), views.buildStudentTypeView("edit", profile),
    ...(["uoft", "other_university", "high_school"] as const).map((type) => views.buildProfileFormView("onboard", type, null)),
    views.buildHoursFormView(formData, views.emptyHoursFormValues()),
    views.buildHoursFormView(formData, views.emptyHoursFormValues(), null, { submissionId: "s1", asExec: true }),
    views.buildRejectReasonView("s1:0"), views.buildRejectReasonView("s1:0", 0, "exec"), views.buildRecordsPickView(),
    buildRequestsView({ title: "t", heading: "h", requests: [submission], back: "member", editBack: "my", emptyText: "e" }),
    buildPendingView({ requests: [submission], total: 1, canApprove: true, back: "exec" }),
    buildMemberHomeView({ rows: [], approvedHours: 0, pendingHours: 0, rejectedHours: 2 }, { isExec: true, isAdmin: true }),
    buildExecHomeView(2), buildAdminHomeView(context),
    buildDoneView({ title: "t", body: "b", actions: [{ label: "x", actionId: "vol_hub_hours", value: "member" }] }),
    buildReportFormView(formData.years), buildReportFormView(formData.years, null, "letterhead"),
    adminViews.buildYearsView(context), adminViews.buildYearView(context, formData.years[0] as never),
    adminViews.buildYearFormView(formData.years[0] as never, undefined, "years"), adminViews.buildYearFormView(null, undefined, "years"),
    adminViews.buildStaffView(context), adminViews.buildStaffFormView(staff, "staff"), adminViews.buildStaffFormView(null, "staff"),
    adminViews.buildCategoriesView(context), adminViews.buildCategoryFormView(formData.categories[0] as never, "categories"),
    adminViews.buildCategoryFormView(null, "categories"), adminViews.buildEventsView(context),
    adminViews.buildEventFormView(formData.events[0] as never, "events"), adminViews.buildEventFormView(null, "events"),
    adminViews.buildLinkFormView("home"),
    views.buildApprovalCard(submission, "UPRIMARY"),
  ];
}

describe("every button, search box and form on every screen has a handler", () => {
  before(() => {
    for (const kind of patched) {
      originals.set(kind, (App.prototype as never)[kind]);
      (App.prototype as never as Record<string, unknown>)[kind] = (id: string | RegExp | { action_id?: string }) => {
        const key = typeof id === "object" && !(id instanceof RegExp) && id.action_id ? id.action_id : id;

        if (kind === "command" || kind === "view") registered[kind].add(String(key));
        else registered[kind].push(key as string | RegExp);
      };
    }
    process.env.SLACK_VOLUNTEER_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_VOLUNTEER_APPROVALS_CHANNEL_ID = "C0000000001";
    createVolunteerSlackApp({ volunteer: {}, reports: {}, admin: {} } as unknown as VolunteerServices, {
      receiver: { init() {}, start: async () => undefined, stop: async () => undefined } as never,
    });
  });

  after(() => {
    for (const kind of patched) {
      (App.prototype as never as Record<string, unknown>)[kind] = originals.get(kind);
    }
  });

  const interactiveIds = () => {
    const actionIds = new Set<string>();
    const callbackIds = new Set<string>();
    const add = (element: { action_id?: unknown } | undefined) => {
      if (element && typeof element.action_id === "string") actionIds.add(element.action_id);
    };
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      const block = node as Record<string, unknown>;

      if (typeof block.callback_id === "string") callbackIds.add(block.callback_id);
      if (block.type === "actions") (block.elements as Array<{ action_id?: unknown }>).forEach(add);
      if (block.type === "section" && block.accessory) add(block.accessory as { action_id?: unknown });
      if (block.type === "input" && (block.dispatch_action || (block.element as { type?: string })?.type === "external_select" || (block.element as { type?: string })?.type === "multi_external_select")) {
        add(block.element as { action_id?: unknown });
      }
      Object.values(block).forEach(walk);
    };

    walk(allScreens());

    return { actionIds, callbackIds };
  };

  const handled = (id: string, list: Array<string | RegExp>) =>
    list.some((candidate) => (candidate instanceof RegExp ? candidate.test(id) : candidate === id));

  it("registers exactly the three commands", () => {
    assert.deepEqual([...registered.command].sort(), ["/volunteer", "/volunteer-admin", "/volunteer-exec"]);
  });

  it("has a handler for every button and select", () => {
    const { actionIds } = interactiveIds();
    const missing = [...actionIds].filter((id) => !handled(id, [...registered.action, ...registered.options]));

    assert.ok(actionIds.size >= 20, `only ${actionIds.size} interactive ids found`);
    assert.deepEqual(missing, []);
  });

  it("has a submit handler for every form", () => {
    const { callbackIds } = interactiveIds();

    assert.ok(callbackIds.size >= 7, `only ${callbackIds.size} forms found`);
    assert.deepEqual([...callbackIds].filter((id) => !registered.view.has(id)), []);
  });

  it("has no form handler that no screen uses", () => {
    const { callbackIds } = interactiveIds();

    assert.deepEqual([...registered.view].filter((id) => !callbackIds.has(id)), []);
  });
});
