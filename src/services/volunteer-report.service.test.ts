import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReportFilters } from "../domain/volunteer-report.js";
import { InMemoryVolunteerRepository } from "../repositories/in-memory-volunteer.repository.js";
import { buildReportCsv } from "../volunteer-reports/csv.js";
import { sortReportEntries } from "../volunteer-reports/sorting.js";
import { VolunteerReportService } from "./volunteer-report.service.js";
import { VolunteerService } from "./volunteer.service.js";

const YEAR_ID = "11111111-1111-4111-8111-111111111111";
const GENERAL_ID = "22222222-2222-4222-8222-222222222222";

function setup() {
  const repository = new InMemoryVolunteerRepository({
    years: [
      {
        id: YEAR_ID,
        label: "2026/27 Volunteer Year",
        startDate: "2026-09-01",
        endDate: "2027-08-31",
        isDefault: false,
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
    ],
    staff: [
      {
        slackUserId: "UAPPROVER",
        displayName: "Approver",
        title: "Vice President",
        canApprove: true,
        canManage: true,
        isPrimary: true,
      },
      {
        slackUserId: "UNOTITLE",
        displayName: "No Title",
        title: null,
        canApprove: true,
        canManage: false,
        isPrimary: false,
      },
    ],
  });
  const volunteers = new VolunteerService(repository);
  const reports = new VolunteerReportService(repository, {
    organizationName: "UTSC MSA",
    contactLine: null,
    logo: null,
  });

  return { repository, volunteers, reports };
}

async function approvedHours(
  volunteers: VolunteerService,
  slackUserId: string,
  name: string,
  utorid: string,
  studentNumber: string,
  entryDate: string,
  hours: number,
  submissionId: string,
) {
  const [firstName = "", ...rest] = name.split(" ");
  const profile = await volunteers.saveProfile(slackUserId, {
    studentType: "uoft",
    firstName,
    lastName: rest.join(" "),
    preferredEmail: `${utorid}@gmail.com`,
    email: `${utorid}@mail.utoronto.ca`,
    utorid,
    studentNumber,
  });
  assert.equal(profile.ok, true);

  const prepared = await volunteers.prepareSubmission({
    slackSubmissionId: submissionId,
    volunteerSlackUserId: slackUserId,
    categoryId: GENERAL_ID,
    eventId: null,
    description: "Helped out",
    entries: [{ entryDate, hours }],
  });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("setup failed");

  await volunteers.createSubmission(prepared.prepared);
  const decided = await volunteers.decide({
    submissionId: prepared.prepared.id,
    decidedBySlackUserId: "UAPPROVER",
    decision: "approved",
    note: null,
  });
  assert.equal(decided.status, "ok");
}

const filters: ReportFilters = {
  yearId: YEAR_ID,
  studentType: "uoft",
  onlyUnsent: true,
  sort: "name",
  volunteerSlackUserIds: null,
};

describe("generateCombined", () => {
  it("only lets staff generate reports", async () => {
    const { reports } = setup();
    const result = await reports.generateCombined("USTRANGER", filters);

    assert.equal(result.status, "not_authorized");
  });

  it("reports when nothing matches", async () => {
    const { reports } = setup();
    const result = await reports.generateCombined("UAPPROVER", filters);

    assert.equal(result.status, "empty");
  });

  it("builds a CSV and a PDF from approved entries only", async () => {
    const { volunteers, reports } = setup();
    await approvedHours(volunteers, "U1", "Zoë Müller", "mullerzo", "1001234567", "2026-11-12", 2.5, "V1");
    await approvedHours(volunteers, "U2", "Aisha Rahman", "rahmanai", "1005550123", "2026-11-13", 1, "V2");

    const pending = await volunteers.prepareSubmission({
      slackSubmissionId: "V3",
      volunteerSlackUserId: "U1",
      categoryId: GENERAL_ID,
      eventId: null,
      description: "Still pending",
      entries: [{ entryDate: "2026-11-14", hours: 3 }],
    });
    assert.equal(pending.ok, true);
    if (pending.ok) await volunteers.createSubmission(pending.prepared);

    const result = await reports.generateCombined("UAPPROVER", filters);

    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;

    assert.equal(result.report.entryCount, 2);
    assert.equal(result.report.volunteerCount, 2);
    assert.equal(result.report.totalHours, 3.5);
    assert.equal(result.report.files.length, 2);

    const csv = result.report.files.find((file) => file.filename.endsWith(".csv"));
    const pdf = result.report.files.find((file) => file.filename.endsWith(".pdf"));
    assert.ok(csv && pdf);
    assert.match(Buffer.from(csv.content).toString("utf8"), /Aisha Rahman/);
    assert.equal(Buffer.from(pdf.content).subarray(0, 5).toString(), "%PDF-");
    assert.doesNotMatch(Buffer.from(csv.content).toString("utf8"), /Still pending/);
  });

  it("skips entries already marked as sent, and picks up later ones", async () => {
    const { volunteers, reports } = setup();
    await approvedHours(volunteers, "U1", "Zoë Müller", "mullerzo", "1001234567", "2026-11-12", 2, "V1");

    const first = await reports.generateCombined("UAPPROVER", filters);
    assert.equal(first.status, "ok");
    if (first.status !== "ok") return;

    // Generating alone must not mark anything as sent.
    const again = await reports.generateCombined("UAPPROVER", filters);
    assert.equal(again.status, "ok");

    const marked = await reports.markSent(first.report.export.id, "UAPPROVER");
    assert.deepEqual(marked, {
      status: "done",
      result: { status: "ok", markedEntries: 1 },
    });

    const twice = await reports.markSent(first.report.export.id, "UAPPROVER");
    assert.equal(twice.status === "done" && twice.result.status, "already_marked");

    const afterSent = await reports.generateCombined("UAPPROVER", filters);
    assert.equal(afterSent.status, "empty");

    await approvedHours(volunteers, "U1", "Zoë Müller", "mullerzo", "1001234567", "2026-11-20", 1, "V2");
    const later = await reports.generateCombined("UAPPROVER", filters);
    assert.equal(later.status, "ok");
    if (later.status === "ok") {
      assert.equal(later.report.entryCount, 1);
    }

    const everything = await reports.generateCombined("UAPPROVER", {
      ...filters,
      onlyUnsent: false,
    });
    assert.equal(everything.status === "ok" && everything.report.entryCount, 2);
  });

  it("blocks non-staff from marking exports as sent", async () => {
    const { volunteers, reports } = setup();
    await approvedHours(volunteers, "U1", "Zoë Müller", "mullerzo", "1001234567", "2026-11-12", 2, "V1");
    const generated = await reports.generateCombined("UAPPROVER", filters);
    assert.equal(generated.status, "ok");
    if (generated.status !== "ok") return;

    const outcome = await reports.markSent(generated.report.export.id, "USTRANGER");
    assert.equal(outcome.status, "not_authorized");
  });
});

describe("generateLetterheads", () => {
  it("makes one letter per volunteer and lists volunteers with no approved hours", async () => {
    const { volunteers, reports } = setup();
    await approvedHours(volunteers, "U1", "Zoë Müller", "mullerzo", "1001234567", "2026-11-12", 2, "V1");

    const result = await reports.generateLetterheads(
      "UAPPROVER",
      { ...filters, volunteerSlackUserIds: ["U1", "U9"] },
      new Map([
        ["U1", "<@U1>"],
        ["U9", "<@U9>"],
      ]),
    );

    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;

    assert.equal(result.report.files.length, 1);
    assert.deepEqual(result.report.skippedVolunteers, ["<@U9>"]);
    assert.equal(
      Buffer.from(result.report.files[0]?.content ?? new Uint8Array())
        .subarray(0, 5)
        .toString(),
      "%PDF-",
    );
  });

  it("won't make letters for a requester with no title on their staff record", async () => {
    const { volunteers, reports } = setup();
    await approvedHours(volunteers, "U1", "Zoë Müller", "mullerzo", "1001234567", "2026-11-12", 2, "V1");

    const result = await reports.generateLetterheads(
      "UNOTITLE",
      { ...filters, volunteerSlackUserIds: ["U1"] },
      new Map([["U1", "<@U1>"]]),
    );

    assert.equal(result.status, "no_signatory");

    // Combined reports don't carry a signature, so they still work.
    const combined = await reports.generateCombined("UNOTITLE", filters);
    assert.equal(combined.status, "ok");
  });

  it("includes hours that were already sent to CCR", async () => {
    const { volunteers, reports } = setup();
    await approvedHours(volunteers, "U1", "Zoë Müller", "mullerzo", "1001234567", "2026-11-12", 2, "V1");
    const generated = await reports.generateCombined("UAPPROVER", filters);
    assert.equal(generated.status, "ok");
    if (generated.status !== "ok") return;
    await reports.markSent(generated.report.export.id, "UAPPROVER");

    const letters = await reports.generateLetterheads(
      "UAPPROVER",
      { ...filters, volunteerSlackUserIds: ["U1"] },
      new Map([["U1", "<@U1>"]]),
    );

    assert.equal(letters.status, "ok");
  });
});

describe("searchVolunteers", () => {
  it("is limited to staff and finds volunteers with or without Slack", async () => {
    const { volunteers, reports, repository } = setup();
    await approvedHours(volunteers, "U1", "Zoë Müller", "mullerzo", "1001234567", "2026-11-12", 2, "V1");
    await repository.upsertProfile("ext_0123456789abcdef", {
      studentType: "high_school",
      firstName: "Zora",
      lastName: "Smith",
      preferredEmail: "z.smith@gmail.com",
      email: "z@example.com",
      utorid: null,
      studentNumber: "HS123456",
    });

    const names = async (user: string, query: string) =>
      (await reports.searchVolunteers(user, query)).map((p) => p.fullName);

    assert.deepEqual(await names("UAPPROVER", "z"), ["Zoë Müller", "Zora Smith"]);
    assert.deepEqual(await names("UAPPROVER", "mullerzo"), ["Zoë Müller"]);
    assert.deepEqual(await names("USTRANGER", "z"), []);
  });
});

describe("csv and sorting", () => {
  const entry = (overrides: Partial<Parameters<typeof buildReportCsv>[0][number]>) => ({
    entryId: "e",
    entryDate: "2026-11-12",
    hours: 1,
    description: "Helped",
    categoryName: "General",
    eventName: null,
    ccrSentAt: null,
    volunteerSlackUserId: "U1",
    fullName: "Zoë Müller",
    email: "z@mail.utoronto.ca",
    studentType: "uoft" as const,
    utorid: "mullerzo",
    studentNumber: "1001234567",
    schoolName: null,
    yearLabel: "2026/27 Volunteer Year",
    ...overrides,
  });

  it("neutralizes formulas, quotes commas, and starts with a BOM", () => {
    const csv = buildReportCsv(
      [
        entry({ description: '=HYPERLINK("http://x")' }),
        entry({ description: "Set up, cleaned up" }),
        entry({ description: "-2+3" }),
      ],
      { includeStudentDetails: false },
    ).toString("utf8");

    assert.ok(csv.startsWith("﻿"));
    assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`));
    assert.ok(csv.includes('"Set up, cleaned up"'));
    assert.ok(csv.includes("'-2+3"));
  });

  it("sorts by name or by date", () => {
    const entries = [
      entry({ entryId: "a", fullName: "Zed", volunteerSlackUserId: "U2", entryDate: "2026-11-01" }),
      entry({ entryId: "b", fullName: "Amy", volunteerSlackUserId: "U3", entryDate: "2026-11-09" }),
      entry({ entryId: "c", fullName: "Amy", volunteerSlackUserId: "U3", entryDate: "2026-11-02" }),
    ];

    assert.deepEqual(
      sortReportEntries(entries, "name").map((row) => row.entryId),
      ["c", "b", "a"],
    );
    assert.deepEqual(
      sortReportEntries(entries, "date").map((row) => row.entryId),
      ["a", "c", "b"],
    );
  });
});
