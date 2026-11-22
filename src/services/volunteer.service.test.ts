import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasSlackAccount } from "../domain/volunteer.js";
import { InMemoryVolunteerRepository } from "../repositories/in-memory-volunteer.repository.js";
import {
  daysBetween,
  isValidIsoDate,
  VolunteerService,
  type ProfileFormInput,
  type SubmissionInput,
} from "./volunteer.service.js";

const YEAR_ID = "11111111-1111-4111-8111-111111111111";
const GENERAL_ID = "22222222-2222-4222-8222-222222222222";
const SPECIFIC_ID = "33333333-3333-4333-8333-333333333333";
const EVENT_ID = "44444444-4444-4444-8444-444444444444";

function createService() {
  const repository = new InMemoryVolunteerRepository({
    years: [
      {
        id: YEAR_ID,
        label: "2026/27 Volunteer Year",
        startDate: "2026-09-01",
        endDate: "2027-08-31",
      },
    ],
    categories: [
      {
        id: GENERAL_ID,
        name: "General",
        requiresEvent: false,
        isActive: true,
        sortOrder: 10,
      },
      {
        id: SPECIFIC_ID,
        name: "Specific Event",
        requiresEvent: true,
        isActive: true,
        sortOrder: 30,
      },
    ],
    events: [
      { id: EVENT_ID, name: "Iftar Night", eventDate: null, isActive: true },
    ],
    staff: [
      {
        slackUserId: "UAPPROVER",
        displayName: "Approver",
        title: null,
        canApprove: true,
        canManage: true,
        isPrimary: true,
      },
      {
        slackUserId: "UVOLUNTEER",
        displayName: "Volunteer who is also an approver",
        title: null,
        canApprove: true,
        canManage: false,
        isPrimary: false,
      },
      {
        slackUserId: "UEXEC",
        displayName: "Exec without approval",
        title: null,
        canApprove: false,
        canManage: true,
        isPrimary: false,
      },
    ],
  });

  return { repository, service: new VolunteerService(repository) };
}

const uoftProfile: ProfileFormInput = {
  studentType: "uoft",
  firstName: "  Jane ",
  lastName: " Doe ",
  preferredEmail: " Jane.Personal@Gmail.com ",
  email: " Jane.Doe@mail.utoronto.ca ",
  utorid: " DoeJane1 ",
  studentNumber: "1001234567",
};

function submission(overrides: Partial<SubmissionInput> = {}): SubmissionInput {
  return {
    slackSubmissionId: "V1",
    volunteerSlackUserId: "UVOLUNTEER",
    categoryId: GENERAL_ID,
    eventId: null,
    description: "Helped set up the prayer room",
    entries: [{ entryDate: "2026-11-12", hours: 2.5 }],
    ...overrides,
  };
}

async function serviceWithProfile(slackUserId = "UVOLUNTEER") {
  const context = createService();
  const result = await context.service.saveProfile(slackUserId, uoftProfile);
  assert.equal(result.ok, true);
  return context;
}

describe("date helpers", () => {
  it("validates real calendar dates only", () => {
    assert.equal(isValidIsoDate("2026-11-12"), true);
    assert.equal(isValidIsoDate("2026-02-30"), false);
    assert.equal(isValidIsoDate("2026-1-2"), false);
  });

  it("counts whole days between dates", () => {
    assert.equal(daysBetween("2026-11-12", "2026-11-15"), 3);
  });
});

describe("saveProfile", () => {
  it("normalizes and stores a UofT profile", async () => {
    const { service } = createService();
    const result = await service.saveProfile("U1", uoftProfile);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.profile.fullName, "Jane Doe");
      assert.equal(result.profile.email, "jane.doe@mail.utoronto.ca");
      assert.equal(result.profile.utorid, "doejane1");
      assert.equal(result.profile.preferredEmail, "jane.personal@gmail.com");
      assert.equal(result.profile.studentNumber, "1001234567");
      assert.equal(result.linkedFrom, null);
    }
  });

  it("rejects a malformed UTORid and student number", async () => {
    const { service } = createService();
    const result = await service.saveProfile("U1", {
      ...uoftProfile,
      utorid: "jane doe@",
      studentNumber: "12345",
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      const fields = result.issues.map((issue) => issue.field).sort();
      assert.deepEqual(fields, ["studentNumber", "utorid"]);
    }
  });

  it("rejects a UTORid already used by another Slack account", async () => {
    const { service } = createService();
    await service.saveProfile("U1", uoftProfile);
    const result = await service.saveProfile("U2", {
      ...uoftProfile,
      studentNumber: "1009999999",
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(
        result.issues.map((issue) => issue.field),
        ["utorid"],
      );
    }
  });

  it("lets the same Slack account update its own profile", async () => {
    const { service } = createService();
    await service.saveProfile("U1", uoftProfile);
    const result = await service.saveProfile("U1", {
      ...uoftProfile,
      firstName: "Jane Q",
    });

    assert.equal(result.ok, true);
  });

  it("asks every student type for a student number, but only UofT for a UTORid", async () => {
    const { service } = createService();

    const missing = await service.saveProfile("U1", {
      ...uoftProfile,
      studentType: "high_school",
      studentNumber: "",
    });
    assert.equal(missing.ok, false);

    const tooShort = await service.saveProfile("U1", {
      ...uoftProfile,
      studentType: "other_university",
      studentNumber: "12",
    });
    assert.equal(tooShort.ok, false);

    const saved = await service.saveProfile("U1", {
      ...uoftProfile,
      studentType: "other_university",
      email: "Jane@YORKU.ca",
      studentNumber: " ab 123-45 ",
    });
    assert.equal(saved.ok, true);
    if (saved.ok) {
      assert.equal(saved.profile.utorid, null);
      assert.equal(saved.profile.studentNumber, "AB123-45");
      assert.equal(saved.profile.email, "jane@yorku.ca");
    }
  });

  it("treats the student number as unique per student type", async () => {
    const { service } = createService();
    await service.saveProfile("UHS", {
      ...uoftProfile,
      studentType: "high_school",
      studentNumber: "123456789",
    });

    // Same number, different type: a different person.
    const uoft = await service.saveProfile("UUOFT", {
      ...uoftProfile,
      studentNumber: "123456789",
    });
    assert.equal(uoft.ok, true);

    // Same number and type: the same person, so it's refused for someone else.
    const clash = await service.saveProfile("UOTHER", {
      ...uoftProfile,
      utorid: "different1",
      studentNumber: "123456789",
    });
    assert.equal(clash.ok, false);
  });
});

describe("prepareSubmission", () => {
  it("requires a profile first", async () => {
    const { service } = createService();
    const result = await service.prepareSubmission(submission());

    assert.equal(result.ok, false);
  });

  it("prepares a valid submission and resolves the volunteer year", async () => {
    const { service } = await serviceWithProfile();
    const result = await service.prepareSubmission(
      submission({
        entries: [
          { entryDate: "2026-11-12", hours: 2.5 },
          { entryDate: "2026-11-13", hours: 1 },
        ],
      }),
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.prepared.entries.length, 2);
      assert.equal(result.prepared.entries[0]?.yearId, YEAR_ID);
    }
  });

  it("flags hours over 24, zero hours, and duplicate dates per row", async () => {
    const { service } = await serviceWithProfile();
    const result = await service.prepareSubmission(
      submission({
        entries: [
          { entryDate: "2026-11-12", hours: 25 },
          { entryDate: "2026-11-13", hours: 0 },
          { entryDate: "2026-11-13", hours: 1 },
        ],
      }),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      const rows = result.issues.flatMap((issue) =>
        issue.target === "entry" ? [issue.index] : [],
      );
      assert.deepEqual(rows.sort(), [0, 1, 2]);
    }
  });

  it("rejects dates outside every volunteer year", async () => {
    const { service } = await serviceWithProfile();
    const result = await service.prepareSubmission(
      submission({ entries: [{ entryDate: "2025-01-05", hours: 1 }] }),
    );

    assert.equal(result.ok, false);
  });

  it("requires an event for categories that need one", async () => {
    const { service } = await serviceWithProfile();
    const missing = await service.prepareSubmission(
      submission({ categoryId: SPECIFIC_ID }),
    );
    assert.equal(missing.ok, false);

    const ok = await service.prepareSubmission(
      submission({ categoryId: SPECIFIC_ID, eventId: EVENT_ID }),
    );
    assert.equal(ok.ok, true);
  });

  it("drops the event for categories that don't use one", async () => {
    const { service } = await serviceWithProfile();
    const result = await service.prepareSubmission(
      submission({ eventId: EVENT_ID }),
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.prepared.eventId, null);
    }
  });

  it("enforces 24 hours per day across submissions, ignoring rejected ones", async () => {
    const { service } = await serviceWithProfile();
    const first = await service.prepareSubmission(
      submission({ entries: [{ entryDate: "2026-11-12", hours: 20 }] }),
    );
    assert.equal(first.ok, true);
    if (!first.ok) return;
    await service.createSubmission(first.prepared);

    const over = await service.prepareSubmission(
      submission({
        slackSubmissionId: "V2",
        entries: [{ entryDate: "2026-11-12", hours: 5 }],
      }),
    );
    assert.equal(over.ok, false);

    const decided = await service.decide({
      submissionId: first.prepared.id,
      decidedBySlackUserId: "UAPPROVER",
      decision: "rejected",
      note: "Wrong date",
    });
    assert.equal(decided.status, "ok");

    const afterReject = await service.prepareSubmission(
      submission({
        slackSubmissionId: "V3",
        entries: [{ entryDate: "2026-11-12", hours: 5 }],
      }),
    );
    assert.equal(afterReject.ok, true);
  });

  it("caps the number of dates in one submission", async () => {
    const { service } = await serviceWithProfile();
    const entries = Array.from({ length: 16 }, (_, index) => ({
      entryDate: `2026-11-${String(index + 1).padStart(2, "0")}`,
      hours: 1,
    }));
    const result = await service.prepareSubmission(submission({ entries }));

    assert.equal(result.ok, false);
  });
});

describe("createSubmission", () => {
  it("is idempotent on the Slack submission id", async () => {
    const { service } = await serviceWithProfile();
    const prepared = await service.prepareSubmission(submission());
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;

    const first = await service.createSubmission(prepared.prepared);
    const second = await service.createSubmission({
      ...prepared.prepared,
      id: "55555555-5555-4555-8555-555555555555",
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.submission.id, first.submission.id);
  });
});

describe("decide", () => {
  async function pendingSubmission() {
    const context = await serviceWithProfile();
    const prepared = await context.service.prepareSubmission(submission());
    assert.equal(prepared.ok, true);
    if (!prepared.ok) throw new Error("setup failed");
    await context.service.createSubmission(prepared.prepared);
    return { ...context, submissionId: prepared.prepared.id };
  }

  it("blocks users who can't approve", async () => {
    const { service, submissionId } = await pendingSubmission();

    for (const userId of ["UEXEC", "USTRANGER"]) {
      const result = await service.decide({
        submissionId,
        decidedBySlackUserId: userId,
        decision: "approved",
        note: null,
      });
      assert.equal(result.status, "not_authorized");
    }
  });

  it("requires a reason to disapprove", async () => {
    const { service, submissionId } = await pendingSubmission();
    const result = await service.decide({
      submissionId,
      decidedBySlackUserId: "UAPPROVER",
      decision: "rejected",
      note: "   ",
    });

    assert.equal(result.status, "note_required");
  });

  it("approves, and only the first decision wins", async () => {
    const { service, submissionId } = await pendingSubmission();
    const first = await service.decide({
      submissionId,
      decidedBySlackUserId: "UAPPROVER",
      decision: "approved",
      note: null,
    });
    const second = await service.decide({
      submissionId,
      decidedBySlackUserId: "UVOLUNTEER",
      decision: "rejected",
      note: "Too late",
    });

    assert.equal(first.status, "ok");
    assert.equal(second.status, "already_decided");
    if (second.status === "already_decided") {
      assert.equal(second.submission.status, "approved");
      assert.equal(second.submission.decidedBySlackUserId, "UAPPROVER");
    }
  });

  it("allows an approver to approve their own hours", async () => {
    const { service, submissionId } = await pendingSubmission();
    const result = await service.decide({
      submissionId,
      decidedBySlackUserId: "UVOLUNTEER",
      decision: "approved",
      note: null,
    });

    assert.equal(result.status, "ok");
  });

  it("reports a missing submission", async () => {
    const { service } = createService();
    const result = await service.decide({
      submissionId: "66666666-6666-4666-8666-666666666666",
      decidedBySlackUserId: "UAPPROVER",
      decision: "approved",
      note: null,
    });

    assert.equal(result.status, "not_found");
  });
});

describe("getMyHours", () => {
  it("totals hours by status for one volunteer", async () => {
    const { service } = await serviceWithProfile();
    const first = await service.prepareSubmission(submission());
    const second = await service.prepareSubmission(
      submission({
        slackSubmissionId: "V2",
        entries: [{ entryDate: "2026-11-13", hours: 1.5 }],
      }),
    );
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;

    await service.createSubmission(first.prepared);
    await service.createSubmission(second.prepared);
    await service.decide({
      submissionId: first.prepared.id,
      decidedBySlackUserId: "UAPPROVER",
      decision: "approved",
      note: null,
    });

    const mine = await service.getMyHours("UVOLUNTEER");
    assert.equal(mine.approvedHours, 2.5);
    assert.equal(mine.pendingHours, 1.5);
    assert.equal(mine.rejectedHours, 0);
    assert.equal(mine.rows.length, 2);
  });
});

describe("logging hours on a volunteer's behalf", () => {
  it("allows execs and env admins, but not plain approvers or volunteers", async () => {
    const { repository } = createService();
    const service = new VolunteerService(repository, new Set(["UENVADMIN"]));

    assert.equal(await service.canSubmitForOthers("UEXEC"), true);
    assert.equal(await service.canSubmitForOthers("UAPPROVER"), true);
    assert.equal(await service.canSubmitForOthers("UENVADMIN"), true);
    assert.equal(await service.canSubmitForOthers("UVOLUNTEER"), false);
    assert.equal(await service.canSubmitForOthers("USTRANGER"), false);
  });

  it("records the volunteer as submitter by default", async () => {
    const { service } = await serviceWithProfile();
    const prepared = await service.prepareSubmission(submission());

    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;

    assert.equal(prepared.prepared.submittedBySlackUserId, "UVOLUNTEER");

    const { submission: saved } = await service.createSubmission(prepared.prepared);
    assert.equal(saved.submittedBySlackUserId, saved.volunteerSlackUserId);

    const mine = await service.getMyHours("UVOLUNTEER");
    assert.equal(mine.rows[0]?.enteredByStaff, false);
  });

  it("keeps the hours with the volunteer, records the exec, and approves on entry", async () => {
    const { service } = await serviceWithProfile();
    const prepared = await service.prepareSubmission(
      submission({ submittedBySlackUserId: "UEXEC" }),
    );

    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;

    const { submission: saved } = await service.createSubmission(prepared.prepared);
    assert.equal(saved.volunteerSlackUserId, "UVOLUNTEER");
    assert.equal(saved.submittedBySlackUserId, "UEXEC");
    // The exec's entry counts as the approval: no second approver is needed.
    assert.equal(saved.status, "approved");
    assert.equal(saved.decidedBySlackUserId, "UEXEC");
    assert.ok(saved.decidedAt);

    const mine = await service.getMyHours("UVOLUNTEER");
    assert.equal(mine.rows[0]?.enteredByStaff, true);
    assert.equal(mine.approvedHours, 2.5);
    assert.equal(mine.pendingHours, 0);

    // Nothing is left to decide.
    const again = await service.decide({
      submissionId: saved.id,
      decidedBySlackUserId: "UAPPROVER",
      decision: "rejected",
      note: "no",
    });
    assert.equal(again.status, "already_decided");
  });

  it("leaves hours the volunteer submits themselves pending", async () => {
    const { service } = await serviceWithProfile();
    const prepared = await service.prepareSubmission(submission());
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;

    assert.equal(prepared.prepared.approvedBySlackUserId, null);
    const { submission: saved } = await service.createSubmission(prepared.prepared);
    assert.equal(saved.status, "pending");
    assert.equal(saved.decidedBySlackUserId, null);
  });

  it("refuses when the submitter isn't allowed to enter hours for others", async () => {
    const { service } = await serviceWithProfile("UOTHER");

    // A stranger, and a staff member who can approve but not manage.
    for (const submittedBy of ["USTRANGER", "UVOLUNTEER"]) {
      const prepared = await service.prepareSubmission(
        submission({
          volunteerSlackUserId: "UOTHER",
          submittedBySlackUserId: submittedBy,
        }),
      );

      assert.equal(prepared.ok, false, submittedBy);
      if (!prepared.ok) {
        assert.match(prepared.issues[0]?.message ?? "", /permission/);
      }
    }
  });

  it("needs the volunteer's profile on file, and says so", async () => {
    const { service } = createService();
    const prepared = await service.prepareSubmission(
      submission({
        volunteerSlackUserId: "UNEWVOLUNTEER",
        submittedBySlackUserId: "UEXEC",
      }),
    );

    assert.equal(prepared.ok, false);
    if (!prepared.ok) {
      assert.match(prepared.issues[0]?.message ?? "", /no profile yet/);
    }
  });

  it("applies the same rules, like the 24 hour day cap, to the volunteer's hours", async () => {
    const { service } = await serviceWithProfile();
    const first = await service.prepareSubmission(
      submission({ entries: [{ entryDate: "2026-11-12", hours: 20 }] }),
    );
    assert.equal(first.ok, true);
    if (!first.ok) return;
    await service.createSubmission(first.prepared);

    const second = await service.prepareSubmission(
      submission({
        slackSubmissionId: "V2",
        submittedBySlackUserId: "UEXEC",
        entries: [{ entryDate: "2026-11-12", hours: 5 }],
      }),
    );

    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.match(second.issues[0]?.message ?? "", /They already have 20 h/);
    }
  });

  it("lets an exec create a missing profile, but never overwrite an existing one", async () => {
    const { service } = createService();

    const denied = await service.saveProfile("UNEW", uoftProfile, "USTRANGER");
    assert.equal(denied.ok, false);
    assert.equal(await service.getProfile("UNEW"), null);

    const created = await service.saveProfile("UNEW", uoftProfile, "UEXEC");
    assert.equal(created.ok, true);
    assert.equal((await service.getProfile("UNEW"))?.utorid, "doejane1");

    const overwrite = await service.saveProfile(
      "UNEW",
      { ...uoftProfile, firstName: "Someone", lastName: "Else", utorid: "other1", studentNumber: "1009999999" },
      "UEXEC",
    );
    assert.equal(overwrite.ok, false);
    assert.equal((await service.getProfile("UNEW"))?.fullName, "Jane Doe");
  });

  it("words profile errors about the volunteer, not the admin", async () => {
    const { service } = createService();
    const result = await service.saveProfile(
      "UNEW",
      { ...uoftProfile, firstName: "" },
      "UEXEC",
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.issues[0]?.message, "Enter their first name.");
    }
  });
});

describe("hours entered for a volunteer who isn't on Slack", () => {
  it("creates a placeholder key that can never be a Slack ID", () => {
    const { service } = createService();
    const key = service.newExternalVolunteerKey();

    assert.equal(hasSlackAccount(key), false);
    assert.equal(hasSlackAccount("UABC123456"), true);
    assert.notEqual(key, service.newExternalVolunteerKey());
  });

  it("lets an exec add a volunteer and log their hours with no Slack involved", async () => {
    const { service } = createService();
    const key = service.newExternalVolunteerKey();

    const saved = await service.saveProfile(key, uoftProfile, "UEXEC");
    assert.equal(saved.ok, true);

    const prepared = await service.prepareSubmission(
      submission({
        slackSubmissionId: "VX1",
        volunteerSlackUserId: key,
        submittedBySlackUserId: "UEXEC",
      }),
    );
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;

    const { submission: created } = await service.createSubmission(prepared.prepared);
    assert.equal(created.volunteerSlackUserId, key);
    assert.equal(created.volunteerName, "Jane Doe");
    assert.equal(created.status, "approved");
  });

  it("points the exec at the existing volunteer instead of making a duplicate", async () => {
    const { service } = createService();
    await service.saveProfile("UEXISTING", uoftProfile);

    const duplicate = await service.saveProfile(
      service.newExternalVolunteerKey(),
      { ...uoftProfile, lastName: "D." },
      "UEXEC",
    );

    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) {
      const messages = duplicate.issues.map((issue) => issue.message).join(" ");
      assert.match(messages, /already belongs to Jane Doe/);
      assert.match(messages, /Find a volunteer/);
    }
  });
});

describe("deciding hours", () => {
  it("still lets approvers approve hours they submitted for themselves", async () => {
    const { service } = await serviceWithProfile("UVOLUNTEER");
    const prepared = await service.prepareSubmission(submission());
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    await service.createSubmission(prepared.prepared);

    const result = await service.decide({
      submissionId: prepared.prepared.id,
      decidedBySlackUserId: "UVOLUNTEER",
      decision: "approved",
      note: null,
    });
    assert.equal(result.status, "ok");
  });

  it("reports a missing request as not found", async () => {
    const { service } = createService();
    const result = await service.decide({
      submissionId: "does-not-exist",
      decidedBySlackUserId: "UAPPROVER",
      decision: "approved",
      note: null,
    });

    assert.equal(result.status, "not_found");
  });
});

describe("searchVolunteers", () => {
  it("finds volunteers by name, UTORid or email, for execs only", async () => {
    const { service } = createService();
    await service.saveProfile("UJANE", uoftProfile);
    await service.saveProfile(service.newExternalVolunteerKey(), {
      ...uoftProfile,
      firstName: "Sam",
      lastName: "Smith",
      email: "sam@example.com",
      utorid: "smithsam",
      studentNumber: "1007654321",
    }, "UEXEC");

    const names = async (user: string, query: string) =>
      (await service.searchVolunteers(user, query)).map((p) => p.fullName);

    assert.deepEqual(await names("UEXEC", "jane"), ["Jane Doe"]);
    assert.deepEqual(await names("UEXEC", "SMITHSAM"), ["Sam Smith"]);
    assert.deepEqual(await names("UEXEC", "example.com"), ["Sam Smith"]);
    assert.deepEqual(await names("UEXEC", "zzz"), []);
    assert.deepEqual(await names("UEXEC", "   "), []);
    // Not an exec: no access to the volunteer list.
    assert.deepEqual(await names("UVOLUNTEER", "jane"), []);
    assert.deepEqual(await names("USTRANGER", "jane"), []);
  });
});

describe("linking a volunteer who joins Slack to the record an exec added", () => {
  async function addedByExec(overrides: Partial<ProfileFormInput> = {}) {
    const context = createService();
    const key = context.service.newExternalVolunteerKey();
    const saved = await context.service.saveProfile(
      key,
      { ...uoftProfile, ...overrides },
      "UEXEC",
    );
    assert.equal(saved.ok, true);

    return { ...context, key };
  }

  it("links when the student number and UTORid both match, and keeps the hours", async () => {
    const { service, repository, key } = await addedByExec();
    const prepared = await service.prepareSubmission(
      submission({
        slackSubmissionId: "VL1",
        volunteerSlackUserId: key,
        submittedBySlackUserId: "UEXEC",
      }),
    );
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    await service.createSubmission(prepared.prepared);

    // The volunteer joins Slack and onboards, with the name capitalised differently.
    const result = await service.saveProfile("UJANE00001", {
      ...uoftProfile,
      firstName: "JANE",
      utorid: "DOEJANE1",
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.linkedFrom, key);
    assert.equal(result.profile.slackUserId, "UJANE00001");
    assert.equal(result.profile.firstName, "JANE");

    // One record, now under their Slack ID, with the exec's hours attached.
    assert.equal(await service.getProfile(key), null);
    assert.equal(await repository.findProfileByStudentKey("uoft", "1001234567").then((p) => p?.slackUserId), "UJANE00001");
    const mine = await service.getMyHours("UJANE00001");
    assert.equal(mine.approvedHours, 2.5);
    assert.equal(mine.rows[0]?.enteredByStaff, true);
  });

  it("won't link when the UTORid differs, even though the student number matches", async () => {
    const { service, key } = await addedByExec();
    const result = await service.saveProfile("UJANE00001", {
      ...uoftProfile,
      utorid: "someoneelse",
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.issues.map((issue) => issue.field), ["studentNumber"]);
      assert.match(result.issues[0]?.message ?? "", /don't match it/);
    }
    // Nothing moved.
    assert.ok(await service.getProfile(key));
    assert.equal(await service.getProfile("UJANE00001"), null);
  });

  it("won't link when only the UTORid matches", async () => {
    const { service, key } = await addedByExec();
    const result = await service.saveProfile("UJANE00001", {
      ...uoftProfile,
      studentNumber: "1009999999",
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.issues.map((issue) => issue.field), ["utorid"]);
    }
    assert.ok(await service.getProfile(key));
  });

  it("links other students on student number plus email, ignoring case", async () => {
    const hs = {
      studentType: "high_school" as const,
      email: "Sam@Example.com",
      utorid: "",
      studentNumber: "HS-12345",
    };
    const { service, key } = await addedByExec(hs);

    const wrongEmail = await service.saveProfile("USAM000001", {
      ...uoftProfile,
      ...hs,
      email: "other@example.com",
    });
    assert.equal(wrongEmail.ok, false);
    assert.ok(await service.getProfile(key));

    const result = await service.saveProfile("USAM000001", {
      ...uoftProfile,
      ...hs,
      studentNumber: "hs-12345",
      email: "sam@example.com",
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.linkedFrom, key);
  });

  it("only one Slack account can claim a record; the next is told it's taken", async () => {
    const { service } = await addedByExec();

    assert.equal((await service.saveProfile("UFIRST0001", uoftProfile)).ok, true);

    const second = await service.saveProfile("USECOND001", uoftProfile);
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.match(second.issues[0]?.message ?? "", /another Slack account/);
    }
    assert.equal(await service.getProfile("USECOND001"), null);
  });

  it("won't link a Slack user who already has their own profile", async () => {
    const { service, key } = await addedByExec();
    await service.saveProfile("UHASOWN001", {
      ...uoftProfile,
      utorid: "ownutorid",
      studentNumber: "1005555555",
    });

    // They try to change their own details to match the exec-added record.
    const result = await service.saveProfile("UHASOWN001", uoftProfile);

    assert.equal(result.ok, false);
    assert.ok(await service.getProfile(key));
  });

  it("never links an exec-created record to a volunteer through the exec flow", async () => {
    const { service } = await addedByExec();
    const another = service.newExternalVolunteerKey();
    const result = await service.saveProfile(another, uoftProfile, "UEXEC");

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.issues[0]?.message ?? "", /already belongs to Jane Doe/);
    }
  });
});

describe("editing and deleting a request", () => {
  /** A volunteer with one request of two dates, in the given state. */
  async function requestWith(
    status: "pending" | "approved" | "rejected",
    submittedBy: string = "UVOLUNTEER",
  ) {
    const context = await serviceWithProfile("UVOLUNTEER");
    const prepared = await context.service.prepareSubmission(
      submission({
        submittedBySlackUserId: submittedBy,
        entries: [
          { entryDate: "2026-11-12", hours: 2 },
          { entryDate: "2026-11-13", hours: 3 },
        ],
      }),
    );
    assert.equal(prepared.ok, true);
    if (!prepared.ok) throw new Error("setup");
    await context.service.createSubmission(prepared.prepared);

    if (status !== "pending" && submittedBy === "UVOLUNTEER") {
      await context.service.decide({
        submissionId: prepared.prepared.id,
        decidedBySlackUserId: "UAPPROVER",
        decision: status === "approved" ? "approved" : "rejected",
        note: status === "rejected" ? "wrong date" : null,
      });
    }

    return { ...context, id: prepared.prepared.id };
  }

  async function edit(
    context: Awaited<ReturnType<typeof requestWith>>,
    editor: string,
    overrides: Partial<SubmissionInput> = {},
  ) {
    const prepared = await context.service.prepareSubmission(
      submission({
        slackSubmissionId: "edit",
        editingSubmissionId: context.id,
        submittedBySlackUserId: editor,
        description: "Helped set up the prayer room",
        entries: [
          { entryDate: "2026-11-12", hours: 2 },
          { entryDate: "2026-11-13", hours: 3 },
        ],
        ...overrides,
      }),
    );
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    if (!prepared.ok) throw new Error("prepare failed");

    return { prepared: prepared.prepared, outcome: await context.service.applyEdit(prepared.prepared, editor) };
  }

  it("lets a volunteer fix hours on a pending request, and it stays pending", async () => {
    const context = await requestWith("pending");
    const { outcome } = await edit(context, "UVOLUNTEER", {
      entries: [
        { entryDate: "2026-11-12", hours: 2.5 },
        { entryDate: "2026-11-13", hours: 3 },
      ],
    });

    assert.equal(outcome.status, "ok");
    if (outcome.status !== "ok") return;
    assert.equal(outcome.submission.status, "pending");
    assert.equal(outcome.needsApproval, true);
    assert.equal(outcome.submission.entries[0]?.hours, 2.5);
    assert.equal(outcome.submission.editedBySlackUserId, "UVOLUNTEER");
  });

  it("sends an approved request back to the approvers when the volunteer edits it", async () => {
    const context = await requestWith("approved");
    const { outcome } = await edit(context, "UVOLUNTEER", {
      entries: [
        { entryDate: "2026-11-12", hours: 1 },
        { entryDate: "2026-11-13", hours: 3 },
      ],
    });

    assert.equal(outcome.status, "ok");
    if (outcome.status !== "ok") return;
    assert.equal(outcome.submission.status, "pending");
    assert.equal(outcome.submission.decidedBySlackUserId, null);
    assert.equal(outcome.needsApproval, true);

    const mine = await context.service.getMyHours("UVOLUNTEER");
    assert.equal(mine.approvedHours, 0);
    assert.equal(mine.pendingHours, 4);
  });

  it("lets a volunteer fix a disapproved request instead of resubmitting it", async () => {
    const context = await requestWith("rejected");
    const { outcome } = await edit(context, "UVOLUNTEER", {
      entries: [
        { entryDate: "2026-11-14", hours: 2 },
        { entryDate: "2026-11-13", hours: 3 },
      ],
    });

    assert.equal(outcome.status, "ok");
    if (outcome.status !== "ok") return;
    assert.equal(outcome.submission.status, "pending");
    assert.equal(outcome.submission.decisionNote, null);
    assert.deepEqual(
      outcome.submission.entries.map((entry) => entry.entryDate),
      ["2026-11-13", "2026-11-14"],
    );
  });

  it("approves an exec's edit on the spot, keeping the volunteer's ownership", async () => {
    const context = await requestWith("pending");
    const { outcome, prepared } = await edit(context, "UEXEC", {
      entries: [
        { entryDate: "2026-11-12", hours: 4 },
        { entryDate: "2026-11-13", hours: 3 },
      ],
    });

    assert.equal(prepared.approvedBySlackUserId, "UEXEC");
    assert.equal(outcome.status, "ok");
    if (outcome.status !== "ok") return;
    assert.equal(outcome.submission.status, "approved");
    assert.equal(outcome.submission.decidedBySlackUserId, "UEXEC");
    assert.equal(outcome.submission.volunteerSlackUserId, "UVOLUNTEER");
    assert.equal(outcome.needsApproval, false);
  });

  it("keeps the entry for dates that stay, and adds or drops the others", async () => {
    const context = await requestWith("approved");
    const before = await context.service.getSubmission(context.id);
    const keptId = before?.entries.find((entry) => entry.entryDate === "2026-11-13")?.id;

    const { outcome } = await edit(context, "UEXEC", {
      entries: [
        { entryDate: "2026-11-13", hours: 3.5 },
        { entryDate: "2026-11-15", hours: 1 },
      ],
    });

    assert.equal(outcome.status, "ok");
    if (outcome.status !== "ok") return;
    assert.deepEqual(
      outcome.submission.entries.map((entry) => [entry.entryDate, entry.hours]),
      [["2026-11-13", 3.5], ["2026-11-15", 1]],
    );
    assert.equal(
      outcome.submission.entries.find((entry) => entry.entryDate === "2026-11-13")?.id,
      keptId,
    );
  });

  it("doesn't count the request's own hours against the 24 hour day cap", async () => {
    const context = await requestWith("pending");

    // 2 h are already on the 12th by this very request: raising it to 24 is fine.
    const { outcome } = await edit(context, "UVOLUNTEER", {
      entries: [
        { entryDate: "2026-11-12", hours: 24 },
        { entryDate: "2026-11-13", hours: 3 },
      ],
    });
    assert.equal(outcome.status, "ok");

    // But hours from another request on that day still count.
    const other = await context.service.prepareSubmission(
      submission({
        slackSubmissionId: "other",
        entries: [{ entryDate: "2026-11-20", hours: 20 }],
      }),
    );
    assert.equal(other.ok, true);
    if (!other.ok) return;
    await context.service.createSubmission(other.prepared);

    const tooMuch = await context.service.prepareSubmission(
      submission({
        slackSubmissionId: "edit2",
        editingSubmissionId: context.id,
        entries: [{ entryDate: "2026-11-20", hours: 5 }],
      }),
    );
    assert.equal(tooMuch.ok, false);
  });

  it("does nothing, and doesn't reopen approved hours, when nothing changed", async () => {
    const context = await requestWith("approved");
    const { outcome } = await edit(context, "UVOLUNTEER");

    assert.equal(outcome.status, "unchanged");
    assert.equal((await context.service.getSubmission(context.id))?.status, "approved");
    assert.equal(context.repository.changes.length, 0);
  });

  it("records who changed what in an audit trail", async () => {
    const context = await requestWith("approved");
    await edit(context, "UEXEC", {
      description: "Corrected description",
      entries: [
        { entryDate: "2026-11-12", hours: 2 },
        { entryDate: "2026-11-13", hours: 1 },
      ],
    });

    assert.equal(context.repository.changes.length, 1);
    const change = context.repository.changes[0];
    assert.equal(change?.action, "edit");
    assert.equal(change?.changedBySlackUserId, "UEXEC");
    assert.equal(change?.volunteerSlackUserId, "UVOLUNTEER");
    assert.equal(change?.before.status, "approved");
    assert.equal(change?.before.entries[1]?.hours, 3);
    assert.equal(change?.after?.entries[1]?.hours, 1);
    assert.equal(change?.after?.description, "Corrected description");
  });

  it("only the volunteer or an exec can change a request", async () => {
    const context = await requestWith("pending");

    assert.equal((await context.service.getRequestForEdit("UVOLUNTEER", context.id)).status, "ok");
    assert.equal((await context.service.getRequestForEdit("UEXEC", context.id)).status, "ok");
    assert.equal((await context.service.getRequestForEdit("USTRANGER", context.id)).status, "not_allowed");
    // UAPPROVER can manage, so counts as an exec.
    assert.equal((await context.service.getRequestForEdit("UAPPROVER", context.id)).status, "ok");
    assert.equal((await context.service.getRequestForEdit("does-not-exist", "nope")).status, "not_found");

    const prepared = await context.service.prepareSubmission(
      submission({ slackSubmissionId: "forged", editingSubmissionId: context.id }),
    );
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const forged = await context.service.applyEdit(prepared.prepared, "USTRANGER");
    assert.equal(forged.status, "not_allowed");
  });

  it("won't apply an edit that names a different volunteer than the request's", async () => {
    const context = await requestWith("pending");
    await context.service.saveProfile("UOTHER", { ...uoftProfile, utorid: "other1", studentNumber: "1002222222" });
    const prepared = await context.service.prepareSubmission(
      submission({
        slackSubmissionId: "swap",
        volunteerSlackUserId: "UOTHER",
        submittedBySlackUserId: "UEXEC",
        editingSubmissionId: context.id,
      }),
    );
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;

    assert.equal((await context.service.applyEdit(prepared.prepared, "UEXEC")).status, "not_allowed");
  });

  it("locks a request once any of its hours were sent to CCR", async () => {
    const context = await requestWith("approved");
    const entries = await context.repository.listReportEntries({
      yearId: YEAR_ID,
      studentType: "all",
      onlyUnsent: false,
      sort: "date",
      volunteerSlackUserIds: null,
    });
    const created = await context.repository.createExport({
      generatedBySlackUserId: "UAPPROVER",
      yearId: YEAR_ID,
      kind: "combined",
      filters: {
        yearId: YEAR_ID,
        studentType: "all",
        onlyUnsent: false,
        sort: "date",
        volunteerSlackUserIds: null,
      },
      entryIds: entries.map((entry) => entry.entryId),
      totalHours: 5,
    });
    await context.repository.markExportSent(created.id, "UAPPROVER");

    assert.equal((await context.service.getRequestForEdit("UEXEC", context.id)).status, "locked");
    const { outcome } = await edit(context, "UEXEC");
    assert.equal(outcome.status, "locked");
    assert.equal((await context.service.deleteRequest("UEXEC", context.id)).status, "locked");
    assert.ok(await context.service.getSubmission(context.id));
  });

  it("lets an exec delete a request, keeping a record of it, and no one else", async () => {
    const context = await requestWith("approved");

    assert.equal((await context.service.deleteRequest("UVOLUNTEER", context.id)).status, "not_allowed");
    assert.equal((await context.service.deleteRequest("USTRANGER", context.id)).status, "not_allowed");
    assert.ok(await context.service.getSubmission(context.id));

    const deleted = await context.service.deleteRequest("UEXEC", context.id);
    assert.equal(deleted.status, "ok");
    assert.equal(await context.service.getSubmission(context.id), null);
    assert.equal((await context.service.getMyHours("UVOLUNTEER")).approvedHours, 0);

    const change = context.repository.changes[0];
    assert.equal(change?.action, "delete");
    assert.equal(change?.changedBySlackUserId, "UEXEC");
    assert.equal(change?.before.entries.length, 2);
    assert.equal((await context.service.deleteRequest("UEXEC", context.id)).status, "not_found");
  });

  it("lets execs list a volunteer's requests, and volunteers only their own", async () => {
    const context = await requestWith("pending");

    assert.equal((await context.service.listMyRequests("UVOLUNTEER")).length, 1);
    assert.equal((await context.service.listMyRequests("UOTHER")).length, 0);
    assert.equal((await context.service.listRequestsFor("UEXEC", "UVOLUNTEER"))?.length, 1);
    assert.equal(await context.service.listRequestsFor("UVOLUNTEER", "UVOLUNTEER"), null);
    assert.equal(await context.service.listRequestsFor("USTRANGER", "UVOLUNTEER"), null);
  });
});

describe("refusing a decision made on a card that has since been edited", () => {
  async function pendingRequest() {
    const context = await serviceWithProfile("UVOLUNTEER");
    const prepared = await context.service.prepareSubmission(submission());
    assert.equal(prepared.ok, true);
    if (!prepared.ok) throw new Error("setup");
    const { submission: created } = await context.service.createSubmission(prepared.prepared);

    return { ...context, id: created.id, version: created.version };
  }

  async function editHours(
    context: Awaited<ReturnType<typeof pendingRequest>>,
    hours: number,
  ) {
    const prepared = await context.service.prepareSubmission(
      submission({
        slackSubmissionId: `edit-${hours}`,
        editingSubmissionId: context.id,
        entries: [{ entryDate: "2026-11-12", hours }],
      }),
    );
    assert.equal(prepared.ok, true);
    if (!prepared.ok) throw new Error("prepare");

    return context.service.applyEdit(prepared.prepared, "UVOLUNTEER");
  }

  it("starts at version 0 and goes up by one with each edit", async () => {
    const context = await pendingRequest();
    assert.equal(context.version, 0);

    await editHours(context, 3);
    assert.equal((await context.service.getSubmission(context.id))?.version, 1);
    await editHours(context, 4);
    assert.equal((await context.service.getSubmission(context.id))?.version, 2);
  });

  it("approves when the card is current", async () => {
    const context = await pendingRequest();
    const result = await context.service.decide({
      submissionId: context.id,
      decidedBySlackUserId: "UAPPROVER",
      decision: "approved",
      note: null,
      expectedVersion: context.version,
    });

    assert.equal(result.status, "ok");
  });

  it("refuses an approval or disapproval of hours that were edited after the card was shown", async () => {
    const context = await pendingRequest();
    await editHours(context, 10);

    for (const decision of ["approved", "rejected"] as const) {
      const result = await context.service.decide({
        submissionId: context.id,
        decidedBySlackUserId: "UAPPROVER",
        decision,
        note: decision === "rejected" ? "no" : null,
        expectedVersion: context.version, // the version the old card carried
      });

      assert.equal(result.status, "stale", decision);
    }

    // Nothing was decided, and the new hours are still waiting for review.
    const current = await context.service.getSubmission(context.id);
    assert.equal(current?.status, "pending");
    assert.equal(current?.entries[0]?.hours, 10);

    // The updated card (new version) can be approved.
    const fresh = await context.service.decide({
      submissionId: context.id,
      decidedBySlackUserId: "UAPPROVER",
      decision: "approved",
      note: null,
      expectedVersion: current?.version ?? -1,
    });
    assert.equal(fresh.status, "ok");
  });

  it("still reports an already-decided request as decided, not stale", async () => {
    const context = await pendingRequest();
    await context.service.decide({
      submissionId: context.id,
      decidedBySlackUserId: "UAPPROVER",
      decision: "approved",
      note: null,
    });

    const again = await context.service.decide({
      submissionId: context.id,
      decidedBySlackUserId: "UAPPROVER",
      decision: "rejected",
      note: "no",
      expectedVersion: context.version,
    });
    assert.equal(again.status, "already_decided");
  });

  it("keeps working for a button with no version", async () => {
    const context = await pendingRequest();
    await editHours(context, 6);

    const result = await context.service.decide({
      submissionId: context.id,
      decidedBySlackUserId: "UAPPROVER",
      decision: "approved",
      note: null,
    });
    assert.equal(result.status, "ok");
  });
});
