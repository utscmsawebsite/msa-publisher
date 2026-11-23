import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VolunteerSubmission } from "../domain/volunteer.js";
import {
  actionIds,
  blockIds,
  buildApprovalCard,
  buildBehalfPickView,
  buildDeletedCard,
  buildHoursFormView,
  buildRecordsPickView,
  buildRejectReasonView,
  parseDecisionValue,
  editContextFromMetadata,
  rejectedText,
  valuesFromSubmission,
  buildProfileFormView,
  buildStudentTypeView,
  emptyHoursFormValues,
  submissionOnBehalfForSubmitterText,
  submissionOnBehalfForVolunteerText,
  targetFromMetadata,
  volunteerOption,
} from "./volunteer-views.js";

const target = { id: "UTARGET", name: "Jane Doe" };
const noSlackTarget = { id: "ext_0123456789abcdef", name: "Sam Smith" };

const formData = {
  categories: [
    { id: "c1", name: "General", requiresEvent: false, isActive: true, sortOrder: 10 },
  ],
  events: [],
  years: [
    { id: "y1", label: "2026/27", startDate: "2026-09-01", endDate: "2027-08-31", isDefault: false },
  ],
};

function submission(
  overrides: Partial<VolunteerSubmission> = {},
): VolunteerSubmission {
  return {
    id: "s1",
    slackSubmissionId: "V1",
    volunteerSlackUserId: "UVOLUNTEER",
    submittedBySlackUserId: "UVOLUNTEER",
    volunteerName: "Jane Doe",
    studentType: "uoft",
    categoryId: "c1",
    categoryName: "General",
    eventId: null,
    eventName: null,
    description: "Helped out",
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
    ],
    ...overrides,
  };
}

function cardText(card: ReturnType<typeof buildApprovalCard>): string {
  return JSON.stringify(card.blocks);
}

describe("profile form fields follow the volunteer sign-up form", () => {
  const labelsFor = (type: "uoft" | "other_university" | "high_school") =>
    (
      buildProfileFormView("onboard", type, null).blocks.filter(
        (block) => block.type === "input",
      ) as unknown as Array<{ label: { text: string } }>
    ).map((input) => input.label.text);

  it("asks UofT students for names, preferred email, UofT email, UTORid and student number", () => {
    assert.deepEqual(labelsFor("uoft"), [
      "First name",
      "Last name",
      "Preferred email",
      "UofT email",
      "UTORid",
      "Student number",
    ]);
  });

  it("asks other university students for a university email and student ID, no UTORid", () => {
    assert.deepEqual(labelsFor("other_university"), [
      "First name",
      "Last name",
      "Preferred email",
      "University email",
      "University student ID / number",
    ]);
  });

  it("asks high school students for an email and student number", () => {
    assert.deepEqual(labelsFor("high_school"), [
      "First name",
      "Last name",
      "Preferred email",
      "Email",
      "Student number",
    ]);
  });

  it("uses the sign-up form's wording for the student types", () => {
    const options = JSON.stringify(buildStudentTypeView("onboard", null).blocks);

    assert.ok(options.includes("UofT student"));
    assert.ok(options.includes("University student outside UofT"));
    assert.ok(options.includes("High school student"));
  });
});

describe("volunteer views for entering hours on someone's behalf", () => {
  it("keeps modal titles within Slack's 24 character limit", () => {
    const views = [
      buildBehalfPickView(),
      buildStudentTypeView("onboard", null, target),
      buildProfileFormView("onboard", "uoft", null, target),
      buildHoursFormView(formData, emptyHoursFormValues(), target),
    ];

    for (const view of views) {
      assert.ok(
        (view.title?.text.length ?? 0) <= 24,
        `${view.title?.text} is too long`,
      );
    }
  });

  it("carries the volunteer through every step in the modal metadata", () => {
    const typeMetadata = JSON.parse(
      buildStudentTypeView("onboard", null, target).private_metadata ?? "{}",
    );
    const profileMetadata = JSON.parse(
      buildProfileFormView("onboard", "uoft", null, target).private_metadata ?? "{}",
    );
    const hoursMetadata = JSON.parse(
      buildHoursFormView(formData, emptyHoursFormValues(), target)
        .private_metadata ?? "{}",
    );

    for (const metadata of [typeMetadata, profileMetadata, hoursMetadata]) {
      assert.equal(metadata.forUserId, "UTARGET");
      assert.equal(metadata.forName, "Jane Doe");
      assert.deepEqual(targetFromMetadata(metadata), target);
    }
  });

  it("leaves the normal forms unchanged when nobody is being entered for", () => {
    const hours = buildHoursFormView(formData, emptyHoursFormValues());

    assert.equal(hours.title?.text, "Log hours");
    assert.equal(JSON.parse(hours.private_metadata ?? "{}").forUserId ?? null, null);
    assert.ok(!JSON.stringify(hours.blocks).includes("on their behalf"));
  });

  it("lets the exec search for a volunteer or add a new one, with no Next button", () => {
    const view = buildBehalfPickView();
    const actions = (view.blocks as unknown as Array<{ type: string; elements?: Array<{ type: string; action_id: string }> }>)
      .filter((block) => block.type === "actions")
      .flatMap((block) => block.elements ?? []);

    assert.deepEqual(
      actions.map((element) => [element.type, element.action_id]),
      [
        ["external_select", actionIds.behalfFind],
        ["button", actionIds.behalfNew],
      ],
    );
    assert.equal(view.submit, undefined);
    assert.equal(view.callback_id, undefined);
    assert.ok(!view.blocks.some((block) => block.type === "input"));
  });

  it("says when the volunteer isn't on Slack, and never mentions a fake user", () => {
    const noSlack = JSON.stringify(
      buildHoursFormView(formData, emptyHoursFormValues(), noSlackTarget).blocks,
    );
    const newcomer = JSON.stringify(
      buildStudentTypeView("onboard", null, { id: noSlackTarget.id, name: null }).blocks,
    );
    const withSlack = JSON.stringify(
      buildHoursFormView(formData, emptyHoursFormValues(), target).blocks,
    );

    assert.ok(noSlack.includes("Sam Smith"));
    assert.ok(noSlack.includes("not on Slack"));
    assert.ok(!noSlack.includes("<@ext_"));
    assert.ok(newcomer.includes("a new volunteer who isn't on Slack"));
    assert.ok(withSlack.includes("<@UTARGET>"));
  });

  it("labels search results and marks volunteers without Slack", () => {
    const profile = {
      slackUserId: "UABC123456",
      studentType: "uoft" as const,
      firstName: "Jane",
      lastName: "Doe",
      fullName: "Jane Doe",
      preferredEmail: "jane@gmail.com",
      email: "jane@mail.utoronto.ca",
      utorid: "doejane1",
      studentNumber: "1001234567",
    };

    assert.equal(volunteerOption(profile).value, "UABC123456");
    assert.equal(volunteerOption(profile).text.text, "Jane Doe · doejane1");

    const noSlack = volunteerOption({
      ...profile,
      slackUserId: "ext_0123456789abcdef",
      utorid: null,
      studentNumber: "HS123456",
      studentType: "high_school",
    });
    assert.equal(noSlack.value, "ext_0123456789abcdef");
    assert.ok(noSlack.text.text.endsWith("· no Slack"));
    assert.ok(noSlack.text.text.length <= 75);
  });

  it("shows who submitted the request on the approval card", () => {
    const self = cardText(buildApprovalCard(submission(), null));
    const behalf = cardText(
      buildApprovalCard(submission({ submittedBySlackUserId: "UEXEC" }), null),
    );

    assert.ok(self.includes("Submitted by the volunteer"));
    assert.ok(!self.includes("on the volunteer's behalf"));
    assert.ok(behalf.includes("Entered by <@UEXEC> on the volunteer's behalf"));
    assert.ok(!behalf.includes("Submitted by the volunteer"));
  });

  it("shows a volunteer without Slack by name on the card and in the exec's messages", () => {
    const noSlack = submission({
      volunteerSlackUserId: "ext_0123456789abcdef",
      submittedBySlackUserId: "UEXEC",
      volunteerName: "Sam Smith",
    });
    const card = cardText(buildApprovalCard(noSlack, null));

    assert.ok(card.includes("No Slack account"));
    assert.ok(!card.includes("<@ext_"));
    assert.ok(card.includes("Entered by <@UEXEC>"));
    assert.ok(submissionOnBehalfForSubmitterText(noSlack).includes("*Sam Smith* (no Slack account)"));
    assert.ok(!submissionOnBehalfForSubmitterText(noSlack).includes("<@ext_"));
  });

  it("shows an auto-approved entry with no buttons, and who approved it", () => {
    const entered = submission({
      submittedBySlackUserId: "UEXEC",
      status: "approved",
      decidedBySlackUserId: "UEXEC",
      decidedAt: "2026-11-12 10:00:00+00",
    });
    const card = cardText(buildApprovalCard(entered, "UPRIMARY"));

    assert.ok(card.includes("Entered by <@UEXEC> on the volunteer's behalf"));
    assert.ok(card.includes("Approved by <@UEXEC>"));
    assert.ok(!card.includes("vol_approve"));
    assert.ok(!card.includes("cc <@UPRIMARY>"));
  });

  it("tells the volunteer, and the exec, that the hours were logged and approved", () => {
    const entered = submission({ submittedBySlackUserId: "UEXEC", status: "approved" });

    assert.ok(
      submissionOnBehalfForVolunteerText(entered).includes("<@UEXEC> logged and approved"),
    );
    assert.ok(
      submissionOnBehalfForSubmitterText(entered).includes("Logged and approved"),
    );
  });
});

describe("editing a request", () => {
  const request = submission({
    entries: [
      { id: "e1", entryDate: "2026-11-12", hours: 2, yearId: "y1", ccrSentAt: null },
      { id: "e2", entryDate: "2026-11-14", hours: 3.5, yearId: "y1", ccrSentAt: null },
    ],
  });

  it("fills the form with the request as it is now", () => {
    const values = valuesFromSubmission(request);

    assert.equal(values.categoryId, "c1");
    assert.equal(values.description, "Helped out");
    assert.deepEqual(values.rows, [
      { date: "2026-11-12", hours: "2" },
      { date: "2026-11-14", hours: "3.5" },
    ]);

    const blocks = JSON.stringify(
      buildHoursFormView(formData, values, null, { submissionId: "s1", asExec: false }).blocks,
    );
    assert.ok(blocks.includes('"initial_date":"2026-11-14"'));
    assert.ok(blocks.includes('"initial_value":"3.5"'));
  });

  it("tells a volunteer their edit goes back for review, and an exec it applies at once", () => {
    const text = (asExec: boolean) =>
      JSON.stringify(
        buildHoursFormView(formData, valuesFromSubmission(request), null, {
          submissionId: "s1",
          asExec,
        }).blocks,
      );

    assert.ok(text(false).includes("goes back to the approvers"));
    assert.ok(text(true).includes("takes effect right away"));
  });

  it("offers deleting to execs only", () => {
    const hasDelete = (asExec: boolean) =>
      JSON.stringify(
        buildHoursFormView(formData, valuesFromSubmission(request), null, {
          submissionId: "s1",
          asExec,
        }).blocks,
      ).includes("vol_delete_request");

    assert.equal(hasDelete(true), true);
    assert.equal(hasDelete(false), false);
    // And never on the form for a new request.
    assert.ok(
      !JSON.stringify(buildHoursFormView(formData, emptyHoursFormValues()).blocks).includes(
        "vol_delete_request",
      ),
    );
  });

  it("keeps the edit context through the modal's metadata, so adding a date stays an edit", () => {
    const view = buildHoursFormView(formData, valuesFromSubmission(request), target, {
      submissionId: "s1",
      asExec: true,
    });
    const metadata = JSON.parse(view.private_metadata ?? "{}");

    assert.equal(view.title?.text, "Edit hours");
    assert.equal(view.submit?.text, "Save changes");
    assert.deepEqual(editContextFromMetadata(metadata), { submissionId: "s1", asExec: true });
    assert.equal(metadata.rowCount, 2);
    assert.equal(editContextFromMetadata({}), null);
    assert.equal(
      JSON.parse(buildHoursFormView(formData, emptyHoursFormValues()).private_metadata ?? "{}")
        .editSubmissionId,
      null,
    );
  });

  it("marks an edited request on its approval card", () => {
    const edited = submission({
      editedBySlackUserId: "UEXEC",
      editedAt: "2026-11-13 09:00:00+00",
    });

    assert.ok(cardText(buildApprovalCard(edited, null)).includes("Edited by <@UEXEC>"));
    assert.ok(!cardText(buildApprovalCard(submission(), null)).includes("Edited by"));
  });

  it("replaces a deleted request's card with a notice and no buttons", () => {
    const card = cardText(buildDeletedCard(request, "UEXEC"));

    assert.ok(card.includes("Deleted by <@UEXEC>"));
    assert.ok(!card.includes("vol_approve"));
  });

  it("tells a volunteer whose hours were disapproved where to fix them", () => {
    assert.ok(rejectedText(submission({ status: "rejected" })).includes("/volunteer"));
  });

  it("lets an exec search for a volunteer", () => {
    const pick = buildRecordsPickView();

    assert.equal(
      (pick.blocks.find((block) => block.type === "input") as unknown as {
        element: { type: string };
      }).element.type,
      "external_select",
    );
    assert.ok((pick.title?.text.length ?? 0) <= 24);
  });
});

describe("approval buttons carry the version they were shown with", () => {
  const buttonValues = (card: ReturnType<typeof buildApprovalCard>) =>
    (
      card.blocks.find((block) => block.type === "actions") as unknown as {
        elements: Array<{ value: string }>;
      }
    ).elements.map((element) => element.value);

  it("puts the request id and version in both buttons", () => {
    assert.deepEqual(buttonValues(buildApprovalCard(submission({ version: 3 }), null)), [
      "s1:3",
      "s1:3",
    ]);
  });

  it("reads a button value back, tolerating older values with no version", () => {
    assert.deepEqual(parseDecisionValue("s1:3"), { submissionId: "s1", version: 3 });
    assert.deepEqual(
      parseDecisionValue("30000000-0000-4000-8000-000000000001:0"),
      { submissionId: "30000000-0000-4000-8000-000000000001", version: 0 },
    );
    assert.deepEqual(parseDecisionValue("s1"), { submissionId: "s1", version: null });
    assert.deepEqual(parseDecisionValue("s1:abc"), { submissionId: "s1:abc", version: null });
    assert.deepEqual(parseDecisionValue("s1:-1"), { submissionId: "s1:-1", version: null });
  });

  it("carries the version into the disapprove reason modal", () => {
    const view = buildRejectReasonView("s1", 4);

    assert.deepEqual(JSON.parse(view.private_metadata ?? "{}"), {
      submissionId: "s1",
      version: 4,
    });
  });
});

describe("the Event dropdown on the hours form", () => {
  const withEvents = {
    ...formData,
    categories: [
      ...formData.categories,
      { id: "c2", name: "Specific Event", requiresEvent: true, isActive: true, sortOrder: 20 },
    ],
    events: [{ id: "e1", name: "Fall Iftar", eventDate: "2026-11-20", isActive: true }],
  };
  const blocksOf = (view: { blocks?: unknown[] }) => (view.blocks ?? []) as Array<Record<string, unknown>>;
  const eventBlock = (view: { blocks?: unknown[] }) =>
    blocksOf(view).find((block) => block.block_id === blockIds.event);
  const picked = (categoryId: string | null, eventId: string | null = null) => ({
    ...emptyHoursFormValues(),
    categoryId,
    eventId,
  });

  it("isn't there until a category that asks for an event is picked", () => {
    assert.equal(eventBlock(buildHoursFormView(withEvents, picked(null))), undefined);
    assert.equal(eventBlock(buildHoursFormView(withEvents, picked("c1"))), undefined);
    assert.ok(!JSON.stringify(buildHoursFormView(withEvents, picked("c1")).blocks).includes("Required when"));
  });

  it("appears, and is required, for a category that asks for an event", () => {
    const block = eventBlock(buildHoursFormView(withEvents, picked("c2")));

    assert.ok(block, "the Event dropdown should be shown");
    assert.notEqual(block.optional, true);
    assert.ok(JSON.stringify(block).includes("Fall Iftar"));
  });

  it("keeps the event a request already has when it is edited", () => {
    const block = eventBlock(buildHoursFormView(withEvents, picked("c2", "e1")));
    const element = block?.element as { initial_option?: { value?: string } } | undefined;

    assert.equal(element?.initial_option?.value, "e1");
  });

  it("says so, instead of showing an empty dropdown, when there are no active events", () => {
    const view = buildHoursFormView({ ...withEvents, events: [] }, picked("c2"));

    assert.equal(eventBlock(view), undefined);
    assert.ok(JSON.stringify(view.blocks).includes("needs an event, but none are set up yet"));
  });

  it("redraws the form when the category changes", () => {
    const category = blocksOf(buildHoursFormView(withEvents, picked(null))).find(
      (block) => block.block_id === blockIds.category,
    );

    assert.equal(category?.dispatch_action, true);
    assert.equal((category?.element as { action_id?: string }).action_id, actionIds.category);
  });
});
