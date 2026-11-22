import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryVolunteerRepository } from "../repositories/in-memory-volunteer.repository.js";
import { VolunteerAdminService } from "./volunteer-admin.service.js";

function setup() {
  const repository = new InMemoryVolunteerRepository({
    years: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        label: "2026/27 Volunteer Year",
        startDate: "2026-09-01",
        endDate: "2027-08-31",
      },
    ],
    categories: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "General",
        requiresEvent: false,
        isActive: true,
        sortOrder: 10,
      },
    ],
    staff: [
      {
        slackUserId: "UEXEC0001",
        displayName: "Exec",
        title: null,
        canApprove: false,
        canManage: true,
        isPrimary: false,
      },
    ],
  });
  let catalogChanges = 0;
  const admin = new VolunteerAdminService(
    repository,
    new Set(["UADMIN0001"]),
    () => {
      catalogChanges += 1;
    },
  );

  return { repository, admin, changes: () => catalogChanges };
}

describe("staff management", () => {
  it("only lets env admins change staff", async () => {
    const { admin } = setup();
    const result = await admin.setStaffMember("UEXEC0001", {
      slackUserId: "UNEW00001",
      displayName: null,
      title: null,
      canApprove: true,
      canManage: false,
      isPrimary: false,
    });

    assert.equal(result.ok, false);
  });

  it("adds staff, keeps a single primary, and validates permissions", async () => {
    const { admin, repository } = setup();
    const add = (id: string, isPrimary: boolean, canApprove = true) =>
      admin.setStaffMember("UADMIN0001", {
        slackUserId: id,
        displayName: id,
        title: null,
        canApprove,
        canManage: false,
        isPrimary,
      });

    assert.equal((await add("UZAINAB01", true)).ok, true);
    assert.equal((await add("UVP000001", true)).ok, true);

    const staff = await repository.listStaff();
    assert.deepEqual(
      staff.filter((member) => member.isPrimary).map((member) => member.slackUserId),
      ["UVP000001"],
    );

    const noPermissions = await admin.setStaffMember("UADMIN0001", {
      slackUserId: "UNONE0001",
      displayName: null,
      title: null,
      canApprove: false,
      canManage: false,
      isPrimary: false,
    });
    assert.equal(noPermissions.ok, false);

    const primaryWithoutApproval = await add("UBAD00001", true, false);
    assert.equal(primaryWithoutApproval.ok, false);
  });

  it("saves a trimmed title, clears it when left blank, and caps its length", async () => {
    const { admin, repository } = setup();
    const save = (title: string | null) =>
      admin.setStaffMember("UADMIN0001", {
        slackUserId: "UVP000001",
        displayName: "Sara",
        title,
        canApprove: true,
        canManage: false,
        isPrimary: false,
      });
    const stored = async () =>
      (await repository.getStaffMember("UVP000001"))?.title;

    assert.equal((await save("  Vice   President  Community ")).ok, true);
    assert.equal(await stored(), "Vice President Community");

    assert.equal((await save(null)).ok, true);
    assert.equal(await stored(), null);

    assert.equal((await save("Treasurer")).ok, true);
    assert.equal((await save("   ")).ok, true);
    assert.equal(await stored(), null);

    assert.equal((await save("Treasurer")).ok, true);
    assert.equal((await save("x".repeat(81))).ok, false);
    assert.equal(await stored(), "Treasurer");
  });

  it("removes staff", async () => {
    const { admin, repository } = setup();

    assert.equal(
      (await admin.removeStaffMember("UADMIN0001", "UEXEC0001")).ok,
      true,
    );
    assert.equal((await repository.listStaff()).length, 0);
    assert.equal(
      (await admin.removeStaffMember("UADMIN0001", "UEXEC0001")).ok,
      false,
    );
  });
});

describe("catalog management", () => {
  it("requires manage permission", async () => {
    const { admin } = setup();

    assert.equal((await admin.addCategory("USTRANGER", "Outreach", false)).ok, false);
    assert.equal((await admin.addCategory("UEXEC0001", "Outreach", false)).ok, true);
    assert.equal((await admin.addCategory("UADMIN0001", "Fundraising", false)).ok, true);
  });

  it("rejects duplicate category names ignoring case and notifies the cache", async () => {
    const { admin, changes } = setup();

    assert.equal((await admin.addCategory("UEXEC0001", "general", false)).ok, false);
    assert.equal(changes(), 0);

    assert.equal((await admin.addCategory("UEXEC0001", "Outreach", true)).ok, true);
    assert.equal(changes(), 1);
  });

  it("renames and deactivates a category", async () => {
    const { admin, repository } = setup();
    const [category] = await repository.listCategories();
    assert.ok(category);

    const result = await admin.updateCategory("UEXEC0001", category.id, {
      name: "General volunteering",
      isActive: false,
    });

    assert.equal(result.ok, true);
    const [updated] = await repository.listCategories();
    assert.equal(updated?.name, "General volunteering");
    assert.equal(updated?.isActive, false);

    const nothing = await admin.updateCategory("UEXEC0001", category.id, {
      name: null,
      isActive: null,
    });
    assert.equal(nothing.ok, false);
  });

  it("adds and toggles events", async () => {
    const { admin, repository } = setup();

    assert.equal((await admin.addEvent("UEXEC0001", "Iftar Night", "2026-11-20")).ok, true);
    assert.equal((await admin.addEvent("UEXEC0001", "Bad date", "2026-02-30")).ok, false);

    const [event] = await repository.listEvents();
    assert.ok(event);
    assert.equal((await admin.setEventActive("UEXEC0001", event.id, false)).ok, true);
    assert.equal((await repository.listEvents())[0]?.isActive, false);
  });

  it("validates volunteer years", async () => {
    const { admin } = setup();

    assert.equal(
      (await admin.addYear("UEXEC0001", "Backwards", "2028-09-01", "2028-08-31")).ok,
      false,
    );
    assert.equal(
      (await admin.addYear("UEXEC0001", "Overlap", "2027-06-01", "2028-05-31")).ok,
      false,
    );
    assert.equal(
      (await admin.addYear("UEXEC0001", "2026/27 volunteer year", "2028-09-01", "2029-08-31")).ok,
      false,
    );
    assert.equal(
      (await admin.addYear("UEXEC0001", "2027/28 Volunteer Year", "2027-09-01", "2028-08-31")).ok,
      true,
    );
  });
});

describe("linking a volunteer to a Slack account", () => {
  const placeholder = "ext_0123456789abcdef0123456789abcdef";
  const profile = {
    studentType: "uoft" as const,
    firstName: "Jane",
    lastName: "Doe",
    preferredEmail: "jane@gmail.com",
    email: "jane@mail.utoronto.ca",
    utorid: "doejane1",
    studentNumber: "1001234567",
  };

  it("moves a volunteer without Slack onto a Slack user", async () => {
    const { admin, repository } = setup();
    await repository.upsertProfile(placeholder, profile);

    const result = await admin.linkVolunteerToSlack("UEXEC0001", placeholder, "UJANE00001");

    assert.equal(result.ok, true);
    assert.equal(await repository.getProfile(placeholder), null);
    assert.equal((await repository.getProfile("UJANE00001"))?.fullName, "Jane Doe");
  });

  it("is for execs only", async () => {
    const { admin, repository } = setup();
    await repository.upsertProfile(placeholder, profile);

    const result = await admin.linkVolunteerToSlack("USTRANGER", placeholder, "UJANE00001");

    assert.equal(result.ok, false);
    assert.ok(await repository.getProfile(placeholder));
  });

  it("refuses to link anyone already on Slack, or onto a Slack user with their own record", async () => {
    const { admin, repository } = setup();
    await repository.upsertProfile(placeholder, profile);
    await repository.upsertProfile("UALREADY01", {
      ...profile,
      utorid: "other1",
      studentNumber: "1002222222",
    });

    const alreadyLinked = await admin.linkVolunteerToSlack("UEXEC0001", "UALREADY01", "UJANE00001");
    assert.equal(alreadyLinked.ok, false);

    const hasOwn = await admin.linkVolunteerToSlack("UEXEC0001", placeholder, "UALREADY01");
    assert.equal(hasOwn.ok, false);
    assert.ok(await repository.getProfile(placeholder));

    const badUser = await admin.linkVolunteerToSlack("UEXEC0001", placeholder, "not a user");
    assert.equal(badUser.ok, false);

    const missing = await admin.linkVolunteerToSlack("UEXEC0001", "ext_missing", "UJANE00001");
    assert.equal(missing.ok, false);
  });

  it("searches only volunteers who aren't linked yet, for execs", async () => {
    const { admin, repository } = setup();
    await repository.upsertProfile(placeholder, profile);
    await repository.upsertProfile("UALREADY01", {
      ...profile,
      firstName: "Janet",
      utorid: "other1",
      studentNumber: "1002222222",
    });

    const names = async (user: string) =>
      (await admin.searchUnlinkedVolunteers(user, "jane")).map((p) => p.fullName);

    assert.deepEqual(await names("UEXEC0001"), ["Jane Doe"]);
    assert.deepEqual(await names("USTRANGER"), []);
  });
});

describe("editing and deleting a volunteer year", () => {
  const YEAR_ID = "11111111-1111-4111-8111-111111111111";
  const GENERAL_ID = "22222222-2222-4222-8222-222222222222";

  async function logHours(
    repository: InMemoryVolunteerRepository,
    options: {
      id: string;
      volunteer?: string;
      date: string;
      hours: number;
      approvedBy?: string | null;
    },
  ): Promise<void> {
    await repository.createSubmission({
      id: options.id,
      slackSubmissionId: `slack-${options.id}`,
      volunteerSlackUserId: options.volunteer ?? "UVOL00001",
      submittedBySlackUserId: options.volunteer ?? "UVOL00001",
      approvedBySlackUserId: options.approvedBy ?? null,
      categoryId: GENERAL_ID,
      eventId: null,
      description: "Helped out",
      entries: [{ entryDate: options.date, hours: options.hours, yearId: YEAR_ID }],
    });
  }

  it("renames a year at any time, even with hours logged", async () => {
    const { repository, admin, changes } = setup();
    await logHours(repository, { id: "s1", date: "2026-10-01", hours: 2 });

    const result = await admin.updateYear(
      "UEXEC0001",
      YEAR_ID,
      "  2026/27   Year ",
      "2026-09-01",
      "2027-08-31",
    );

    assert.equal(result.ok, true);
    assert.equal((await repository.listYears())[0]?.label, "2026/27 Year");
    assert.equal(changes(), 1);
  });

  it("moves the dates only while every logged date stays inside", async () => {
    const { repository, admin } = setup();
    await logHours(repository, { id: "s1", date: "2026-10-01", hours: 2 });
    await logHours(repository, { id: "s2", date: "2027-03-10", hours: 1 });

    const tooEarly = await admin.updateYear("UEXEC0001", YEAR_ID, "2026/27 Volunteer Year", "2026-09-01", "2027-03-01");

    assert.equal(tooEarly.ok, false);
    assert.match(tooEarly.message, /1 logged date would fall outside/);
    assert.equal((await repository.listYears())[0]?.endDate, "2027-08-31");

    const fine = await admin.updateYear("UEXEC0001", YEAR_ID, "2026/27 Volunteer Year", "2026-09-01", "2027-03-15");

    assert.equal(fine.ok, true);
    assert.equal((await repository.listYears())[0]?.endDate, "2027-03-15");
  });

  it("counts every date that would be left outside", async () => {
    const { repository, admin } = setup();
    await logHours(repository, { id: "s1", date: "2026-09-02", hours: 2 });
    await logHours(repository, { id: "s2", date: "2026-09-03", hours: 1 });

    const result = await admin.updateYear("UEXEC0001", YEAR_ID, "2026/27 Volunteer Year", "2026-10-01", "2027-08-31");

    assert.equal(result.ok, false);
    assert.match(result.message, /2 logged dates would fall outside/);
  });

  it("applies the same checks as adding a year, except against itself", async () => {
    const { admin } = setup();
    await admin.addYear("UEXEC0001", "2027/28 Volunteer Year", "2027-09-01", "2028-08-31");
    const second = (await admin.loadData()).years.find((year) => year.label.startsWith("2027"));

    assert.ok(second);
    const update = (label: string, start: string, end: string) =>
      admin.updateYear("UEXEC0001", second.id, label, start, end);

    assert.equal((await update("2026/27 volunteer year", "2027-09-01", "2028-08-31")).ok, false);
    assert.equal((await update("2027/28 Volunteer Year", "2027-08-01", "2028-08-31")).ok, false);
    assert.equal((await update("2027/28 Volunteer Year", "2028-08-31", "2027-09-01")).ok, false);
    assert.equal((await update("", "2027-09-01", "2028-08-31")).ok, false);
    assert.equal((await update("2027/28 Volunteer Year", "2027-09-02", "2028-08-30")).ok, true);
    // Keeping its own label and dates is not a clash with itself.
    assert.equal((await update("2027/28 Volunteer Year", "2027-09-02", "2028-08-30")).ok, true);
  });

  it("is for execs and admins only, and says when the year is gone", async () => {
    const { admin } = setup();

    assert.equal((await admin.updateYear("UNOBODY01", YEAR_ID, "x", "2026-09-01", "2027-08-31")).ok, false);
    assert.equal((await admin.deleteYear("UNOBODY01", YEAR_ID)).ok, false);
    assert.match(
      (await admin.updateYear("UEXEC0001", "99999999-9999-4999-8999-999999999999", "x", "2030-09-01", "2031-08-31")).message,
      /no longer exists/,
    );
    assert.match(
      (await admin.deleteYear("UEXEC0001", "99999999-9999-4999-8999-999999999999")).message,
      /no longer exists/,
    );
  });

  it("deletes a year only when nothing is logged against it", async () => {
    const { repository, admin, changes } = setup();
    await admin.addYear("UEXEC0001", "2027/28 Volunteer Year", "2027-09-01", "2028-08-31");
    const empty = (await repository.listYears()).find((year) => year.label.startsWith("2027"));

    assert.ok(empty);
    await logHours(repository, { id: "s1", date: "2026-10-01", hours: 2 });

    const blocked = await admin.deleteYear("UEXEC0001", YEAR_ID);

    assert.equal(blocked.ok, false);
    assert.match(blocked.message, /can't be deleted/);
    assert.equal((await repository.listYears()).length, 2);

    const before = changes();
    const deleted = await admin.deleteYear("UEXEC0001", empty.id);

    assert.equal(deleted.ok, true);
    assert.equal((await repository.listYears()).length, 1);
    assert.equal(changes(), before + 1);
  });

  it("won't delete a year a report was generated for", async () => {
    const { repository, admin } = setup();
    await repository.createExport({
      generatedBySlackUserId: "UEXEC0001",
      yearId: YEAR_ID,
      kind: "combined",
      filters: {
        yearId: YEAR_ID,
        studentType: "all",
        onlyUnsent: false,
        sort: "name",
        volunteerSlackUserIds: null,
      },
      entryIds: [],
      totalHours: 0,
    });

    assert.equal((await admin.deleteYear("UEXEC0001", YEAR_ID)).ok, false);
  });

  it("totals what is logged against each year", async () => {
    const { repository, admin } = setup();
    await logHours(repository, { id: "s1", date: "2026-10-01", hours: 2, approvedBy: "UEXEC0001" });
    await logHours(repository, { id: "s2", date: "2026-10-02", hours: 1.5 });
    await logHours(repository, { id: "s3", volunteer: "UVOL00002", date: "2026-10-03", hours: 4, approvedBy: "UEXEC0001" });

    const stats = (await admin.loadData()).yearStats;

    assert.deepEqual(stats, [
      {
        yearId: YEAR_ID,
        volunteers: 2,
        approvedHours: 6,
        pendingHours: 1.5,
        rejectedHours: 0,
        sentHours: 0,
      },
    ]);
  });
});

describe("editing an event", () => {
  it("renames an event and changes its date, with the same checks as adding one", async () => {
    const { repository, admin, changes } = setup();
    await admin.addEvent("UEXEC0001", "Iftar", "2026-11-20");
    const event = (await repository.listEvents())[0];

    assert.ok(event);
    assert.equal((await admin.updateEvent("UEXEC0001", event.id, "  Community   Iftar ", "2026-11-21")).ok, true);
    assert.deepEqual(
      (await repository.listEvents()).map((candidate) => [candidate.name, candidate.eventDate]),
      [["Community Iftar", "2026-11-21"]],
    );
    assert.equal((await admin.updateEvent("UEXEC0001", event.id, "Iftar", null)).ok, true);
    assert.equal((await repository.listEvents())[0]?.eventDate, null);
    assert.equal((await admin.updateEvent("UEXEC0001", event.id, "", null)).ok, false);
    assert.equal((await admin.updateEvent("UEXEC0001", event.id, "x".repeat(81), null)).ok, false);
    assert.equal((await admin.updateEvent("UEXEC0001", event.id, "Iftar", "2026-13-40")).ok, false);
    assert.equal((await admin.updateEvent("UNOBODY01", event.id, "Iftar", null)).ok, false);
    assert.match(
      (await admin.updateEvent("UEXEC0001", "99999999-9999-4999-8999-999999999999", "Iftar", null)).message,
      /no longer exists/,
    );
    assert.ok(changes() >= 3);
  });
});
