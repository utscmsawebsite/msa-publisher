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
import { actionIds, formatDate } from "./volunteer-views.js";

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
