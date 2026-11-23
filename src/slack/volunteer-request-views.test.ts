import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VolunteerSubmission } from "../domain/volunteer.js";
import { hubActionIds } from "./volunteer-hub-views.js";
import {
  buildRequestsView,
  datesLine,
  isLocked,
  MAX_REQUEST_CARDS,
  parseRequestEditValue,
  requestCardText,
  requestEditValue,
  requestTotals,
} from "./volunteer-request-views.js";
import { checkView } from "./volunteer-view-limits.testkit.js";
import { actionIds, formatDate, parseDecisionValue } from "./volunteer-views.js";

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
    submittedAt: "2026-11-12 10:00:00+00",
    editedBySlackUserId: null,
    editedAt: null,
    version: 0,
    entries: [
      { id: "e1", entryDate: "2026-11-12", hours: 2, yearId: "y1", ccrSentAt: null },
      { id: "e2", entryDate: "2026-11-14", hours: 3.5, yearId: "y1", ccrSentAt: null },
    ],
    ...overrides,
  } as VolunteerSubmission;
}

const screen = (requests: VolunteerSubmission[], extra = {}) =>
  buildRequestsView({
    title: "My hours",
    heading: "*Your hours*",
    requests,
    back: "member",
    editBack: "my",
    emptyText: "Nothing yet.",
    ...extra,
  });

const text = (value: unknown) => JSON.stringify(value);

describe("friendly dates", () => {
  it("writes a date the way people say it, without shifting the day", () => {
    assert.equal(formatDate("2026-11-12"), "Nov 12, 2026");
    assert.equal(formatDate("2027-01-01"), "Jan 1, 2027");
    assert.equal(formatDate("2026-12-31"), "Dec 31, 2026");
    assert.equal(formatDate("not a date"), "not a date");
  });
});

describe("a request card", () => {
  it("shows the dates, total hours, status, category and what was done", () => {
    const card = requestCardText(request());

    assert.ok(card.includes("*Nov 12, 2026, Nov 14, 2026*"));
    assert.ok(card.includes("*5.5 h*"));
    assert.ok(card.includes("Pending"));
    assert.ok(card.includes("General"));
    assert.ok(card.includes("Helped set up"));
  });

  it("summarises a long run of dates as a range, and names the event", () => {
    const entries = Array.from({ length: 6 }, (_, index) => ({
      id: `e${index}`,
      entryDate: `2026-11-${String(10 + index).padStart(2, "0")}`,
      hours: 1,
      yearId: "y1",
      ccrSentAt: null,
    }));
    const long = request({ entries, categoryName: "Specific Event", eventName: "Iftar" });

    assert.equal(datesLine(long), "Nov 10, 2026 to Nov 15, 2026 (6 dates)");
    assert.ok(requestCardText(long).includes("Specific Event: Iftar"));
  });

  it("shows why a request was disapproved, and who entered it for the volunteer", () => {
    const card = requestCardText(
      request({ status: "rejected", decisionNote: "Wrong date", submittedBySlackUserId: "UADMIN" }),
    );

    assert.ok(card.includes("Disapproved"));
    assert.ok(card.includes("↳ Wrong date"));
    assert.ok(card.includes("Entered by staff"));
    assert.ok(!requestCardText(request()).includes("Entered by staff"));
  });

  it("can't contain Slack formatting from what a volunteer typed", () => {
    const card = requestCardText(request({ description: "<!channel> & <https://x.com|click>" }));

    assert.ok(!card.includes("<!channel>"));
    assert.ok(card.includes("&lt;!channel&gt;"));
  });
});

describe("the requests screen", () => {
  it("has a Back button first, then the heading, then one card per request with an Edit button", () => {
    const view = screen([request(), request({ id: "s2", status: "approved" })]);
    const blocks = view.blocks as Array<{ type: string; accessory?: { value?: string; action_id?: string } }>;

    assert.equal(blocks[0]?.type, "actions");
    assert.ok(text(blocks[0]).includes(hubActionIds.back));
    assert.ok(text(blocks[1]).includes("Your hours"));
    const edits = blocks.filter((block) => block.accessory?.action_id === actionIds.editRequest);

    assert.deepEqual(
      edits.map((block) => block.accessory?.value),
      ["s1|my", "s2|my"],
    );
  });

  it("locks a request that was sent to CCR: no Edit button, and it says why", () => {
    const sent = request({
      entries: [{ id: "e1", entryDate: "2026-11-12", hours: 2, yearId: "y1", ccrSentAt: "2026-11-20 10:00:00+00" }],
    });
    const view = screen([sent]);

    assert.equal(isLocked(sent), true);
    assert.ok(!text(view).includes(actionIds.editRequest));
    assert.ok(text(view).includes("Sent to CCR"));
  });

  it("says so when there is nothing to show", () => {
    const view = screen([]);

    assert.ok(text(view).includes("Nothing yet."));
    assert.ok(!text(view).includes(actionIds.editRequest));
  });

  it("shows a confirmation with a tick and a warning as written", () => {
    assert.ok(text(screen([], { notice: "Saved it" })).includes("✅ Saved it"));
    assert.ok(!text(screen([], { notice: "⚠️ Careful" })).includes("✅"));
  });

  it("caps the cards, says how many there are, and stays inside Slack's limits", () => {
    const many = Array.from({ length: 150 }, (_, index) => request({ id: `s${index}` }));
    const view = screen(many);

    assert.ok((view.blocks?.length ?? 0) <= 100);
    assert.equal(
      (view.blocks as Array<{ accessory?: unknown }>).filter((block) => block.accessory).length,
      MAX_REQUEST_CARDS,
    );
    assert.ok(text(view).includes(`Showing ${MAX_REQUEST_CARDS} of 150 requests`));
  });

  it("totals approved, pending and disapproved hours", () => {
    const totals = requestTotals([
      request({ status: "approved" }),
      request({ status: "pending" }),
      request({ status: "rejected" }),
      request({ status: "approved" }),
    ]);

    assert.equal(totals, "*Approved:* 11 h   *Pending:* 5.5 h   *Disapproved:* 5.5 h");
  });
});

describe("Approve and Disapprove on a volunteer's request list", () => {
  const decide = { returnTo: "records:UVOL" };
  const buttons = (requests: VolunteerSubmission[], extra = {}) =>
    ((screen(requests, extra).blocks ?? []) as Array<{ type: string; elements?: Array<{ action_id?: string; value?: string; style?: string }> }>)
      .flatMap((block) => (block.type === "actions" ? (block.elements ?? []) : []))
      .filter((element) => element.action_id === actionIds.approve || element.action_id === actionIds.disapprove);

  it("gives each pending request an Approve and a Disapprove button, only when asked", () => {
    const pending = request({ id: "p1", version: 2 });

    assert.deepEqual(buttons([pending]), []);
    const shown = buttons([pending], { decide });

    assert.deepEqual(shown.map((button) => button.action_id), [actionIds.approve, actionIds.disapprove]);
    assert.deepEqual(shown.map((button) => button.style), ["primary", "danger"]);
  });

  it("carries the request, the version it showed, and where to come back to", () => {
    const [approve, disapprove] = buttons([request({ id: "p1", version: 2 })], { decide });

    assert.equal(approve?.value, "p1:2|records:UVOL");
    assert.equal(disapprove?.value, approve?.value);
    assert.deepEqual(parseDecisionValue(approve?.value ?? ""), { submissionId: "p1", version: 2, returnTo: "records:UVOL" });
  });

  it("shows no buttons on requests that are already decided", () => {
    const decided = [
      request({ id: "a1", status: "approved" }),
      request({ id: "r1", status: "rejected", decisionNote: "Wrong date" }),
    ];

    assert.deepEqual(buttons(decided, { decide }), []);
  });

  it("keeps the Edit button on every card, and puts the buttons under their own card", () => {
    const view = screen([request({ id: "p1" }), request({ id: "a1", status: "approved" })], { decide });
    const blocks = (view.blocks ?? []) as Array<{ type: string; accessory?: { action_id?: string }; elements?: Array<{ action_id?: string }> }>;
    const first = blocks.findIndex((block) => block.accessory?.action_id === actionIds.editRequest);

    assert.equal(blocks.filter((block) => block.accessory?.action_id === actionIds.editRequest).length, 2);
    assert.equal(blocks[first + 1]?.elements?.[0]?.action_id, actionIds.approve, "buttons sit right under the pending card");
    assert.notEqual(blocks[first + 2]?.elements?.[0]?.action_id, actionIds.approve, "none under the decided one");
  });

  it("stays inside Slack's limits with a full screen of pending requests", () => {
    const many = Array.from({ length: MAX_REQUEST_CARDS + 5 }, (_, index) => request({ id: `p${index}` }));
    const view = screen(many, { decide });

    assert.deepEqual(checkView(view as never, "records with buttons", "modal"), []);
    assert.ok((view.blocks ?? []).length <= 100);
  });
});

describe("what an Edit button carries", () => {
  it("round-trips the request and where Back should lead", () => {
    assert.deepEqual(parseRequestEditValue(requestEditValue("s1", "my")), { submissionId: "s1", back: "my" });
    assert.deepEqual(parseRequestEditValue(requestEditValue("s1", "records:ext_abc")), {
      submissionId: "s1",
      back: "records:ext_abc",
    });
  });

  it("copes with a bare id or a damaged value", () => {
    assert.deepEqual(parseRequestEditValue("s1"), { submissionId: "s1", back: "member" });
    assert.deepEqual(parseRequestEditValue("s1|nonsense"), { submissionId: "s1", back: "member" });
  });
});
