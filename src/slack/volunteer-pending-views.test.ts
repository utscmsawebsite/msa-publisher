import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VolunteerSubmission } from "../domain/volunteer.js";
import { buildPendingView, pendingCardText } from "./volunteer-pending-views.js";
import { actionIds, decisionValue } from "./volunteer-views.js";

function request(overrides: Partial<VolunteerSubmission> = {}): VolunteerSubmission {
  return {
    id: "s1",
    slackSubmissionId: "V1",
    volunteerSlackUserId: "UVOL",
    submittedBySlackUserId: "UVOL",
    volunteerName: "Jane Doe",
    categoryName: "General",
    eventId: null,
    eventName: null,
    description: "Helped set up",
    status: "pending",
    decidedBySlackUserId: null,
    decidedAt: null,
    decisionNote: null,
    approvalChannelId: null,
    approvalMessageTs: null,
    submittedAt: "2026-11-12 15:00:00+00",
    editedBySlackUserId: null,
    editedAt: null,
    version: 4,
    entries: [
      { id: "e1", entryDate: "2026-11-10", hours: 2, yearId: "y1", ccrSentAt: null },
      { id: "e2", entryDate: "2026-11-11", hours: 3.5, yearId: "y1", ccrSentAt: null },
    ],
    ...overrides,
  } as VolunteerSubmission;
}

const text = (value: unknown) => JSON.stringify(value);
const screen = (extra: Record<string, unknown> = {}) =>
  buildPendingView({ requests: [request()], total: 1, canApprove: true, back: "exec", ...extra });

describe("a pending request card", () => {
  it("names the volunteer and shows dates, hours, what it was, and when it was submitted", () => {
    const card = pendingCardText(request());

    assert.ok(card.includes("*Jane Doe*"));
    assert.ok(card.includes("Nov 10, 2026"));
    assert.ok(card.includes("*5.5 h*"));
    assert.ok(card.includes("General"));
    assert.ok(card.includes("Helped set up"));
    assert.ok(card.includes("Submitted Nov 12, 2026"));
    assert.ok(!card.includes("edited"));
  });

  it("marks a request that was edited after it was first submitted", () => {
    assert.ok(pendingCardText(request({ editedBySlackUserId: "UVOL" })).includes("edited"));
  });

  it("can't carry Slack formatting from what a volunteer typed", () => {
    const card = pendingCardText(request({ description: "<!channel> hi", volunteerName: "<@UEVIL> x" }));

    assert.ok(!card.includes("<!channel>") && !card.includes("<@UEVIL>"));
  });
});

describe("the pending queue screen", () => {
  it("has a Back button, a count, and Approve and Disapprove on every card, carrying the version", () => {
    const view = screen({ requests: [request(), request({ id: "s2", version: 0 })], total: 2 });
    const buttons = (view.blocks as Array<{ type: string; elements?: Array<{ action_id: string; value: string }> }>)
      .filter((block) => block.type === "actions")
      .flatMap((block) => block.elements ?? []);

    assert.ok(text(view.blocks?.[0]).includes("vol_hub_back"));
    assert.ok(text(view).includes("2 waiting, oldest first"));
    assert.deepEqual(
      buttons.slice(1).map((button) => `${button.action_id}:${button.value}`),
      [
        `${actionIds.approve}:${decisionValue(request())}`,
        `${actionIds.disapprove}:${decisionValue(request())}`,
        `${actionIds.approve}:s2:0`,
        `${actionIds.disapprove}:s2:0`,
      ],
    );
  });

  it("shows the queue read-only to someone who can't approve", () => {
    const view = screen({ canApprove: false });

    assert.ok(!text(view).includes(actionIds.approve));
    assert.ok(!text(view).includes(actionIds.disapprove));
    assert.ok(text(view).includes("only staff with the approve permission"));
    assert.ok(text(view).includes("Jane Doe"));
  });

  it("says so when nothing is waiting", () => {
    const view = screen({ requests: [], total: 0 });

    assert.ok(text(view).includes("Nothing is waiting for review"));
    assert.ok(!text(view).includes(actionIds.approve));
  });

  it("says how many more there are when the queue is longer than the page", () => {
    const view = screen({ requests: Array.from({ length: 25 }, (_, i) => request({ id: `s${i}` })), total: 60 });

    assert.ok(text(view).includes("Showing the oldest 25 of 60"));
    assert.ok((view.blocks?.length ?? 0) <= 100);
  });

  it("shows a confirmation with a tick and a warning as written", () => {
    assert.ok(text(screen({ notice: "Approved Jane's 2 h." })).includes("✅ Approved Jane's 2 h."));
    assert.ok(!text(screen({ notice: "⚠️ Already decided" })).includes("✅"));
  });

  it("tells an admin who can't approve how to get the buttons, and an exec without that tip", () => {
    const base = { requests: [request()], total: 1, canApprove: false };
    const forAdmin = JSON.stringify(buildPendingView({ ...base, back: "admin" }));
    const forExec = JSON.stringify(buildPendingView({ ...base, back: "exec" }));

    assert.ok(forAdmin.includes("Setup, Staff"));
    assert.ok(forAdmin.includes("Can approve hours"));
    assert.ok(!forExec.includes("Setup, Staff"));
    assert.ok(forExec.includes("only staff with the approve permission"));
    assert.ok(!forAdmin.includes(actionIds.approve), "still no buttons");
  });
});

