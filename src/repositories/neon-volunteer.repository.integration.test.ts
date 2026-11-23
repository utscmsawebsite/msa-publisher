import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { PoolClient } from "pg";
import { VolunteerReportService } from "../services/volunteer-report.service.js";
import { VolunteerService } from "../services/volunteer.service.js";
import { NeonVolunteerRepository } from "./neon-volunteer.repository.js";

/**
 * Runs the real SQL in `NeonVolunteerRepository` and `migrations/004` against a
 * real Postgres, which the in-memory repository used by the other tests can't
 * check: constraints and indexes, the atomic edit and delete statements,
 * ON UPDATE CASCADE when a volunteer is linked to Slack, generated columns,
 * concurrent claims, and the audit trail.
 *
 * It is skipped unless VOLUNTEER_TEST_DATABASE_URL is set, for example:
 *
 *   VOLUNTEER_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres npm test
 *
 * It is safe to point at a database that has other data: everything happens in
 * a uniquely named schema that is created for the run and dropped afterwards,
 * and nothing outside that schema is touched. Use a local or throwaway database
 * anyway, never production.
 */
const databaseUrl = process.env.VOLUNTEER_TEST_DATABASE_URL;

describe("NeonVolunteerRepository against a real Postgres", {
  skip: databaseUrl ? false : "set VOLUNTEER_TEST_DATABASE_URL to run",
}, () => {
  it("passes the whole scenario", async () => {
    const { default: pg } = await import("pg");
    const schema = `volunteer_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);

    const pool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
      max: 6,
    });
    let lastStep = "(setup)";

    try {
      await pool.query(
        readFileSync(
          new URL("../../migrations/004_create_volunteer_tables.sql", import.meta.url),
          "utf8",
        ),
      );
      await pool.query(
        readFileSync(
          new URL("../../migrations/005_add_volunteer_default_year.sql", import.meta.url),
          "utf8",
        ),
      );
      lastStep = "(migrations applied)";

      class LazyQuery implements PromiseLike<unknown[]> {
        constructor(private readonly run: (client?: PoolClient) => Promise<unknown[]>) {}
        exec(client?: PoolClient) {
          return this.run(client);
        }
        then<T1 = unknown[], T2 = never>(
          onfulfilled?: ((value: unknown[]) => T1 | PromiseLike<T1>) | null,
          onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
        ): Promise<T1 | T2> {
          return this.run().then(onfulfilled, onrejected);
        }
      }

      // Stands in for the Neon driver's tagged template, on a normal pg pool.
      const sql = Object.assign(
        (strings: TemplateStringsArray, ...values: unknown[]) => {
          const text = strings.reduce(
            (query, part, index) => query + part + (index < values.length ? `$${index + 1}` : ""),
            "",
          );

          return new LazyQuery(async (client) => {
            const result = await (client ?? pool).query(text, values);
            return result.rows;
          });
        },
        {
          transaction: async (queries: LazyQuery[]) => {
            const client = await pool.connect();
            try {
              await client.query("BEGIN");
              const out: unknown[] = [];
              for (const query of queries) out.push(await query.exec(client));
              await client.query("COMMIT");
              return out;
            } catch (error) {
              await client.query("ROLLBACK");
              throw error;
            } finally {
              client.release();
            }
          },
        },
      );

      const repo = new NeonVolunteerRepository("unused", sql as never);
      const volunteers = new VolunteerService(repo);
      const reports = new VolunteerReportService(repo, {
        organizationName: "UTSC MSA",
        contactLine: null,
        logo: null,
      });

      const step = (name: string) => {
        lastStep = name;
      };
      const rejects = async (name: string, run: () => Promise<unknown>) => {
        await assert.rejects(run);
        step(`rejected: ${name}`);
      };

      // --- catalog ---
      assert.equal((await repo.listYears()).length, 0); // migration must not seed a year
      await repo.createYear("2026/27 Volunteer Year", "2026-09-01", "2027-08-31");
      const years = await repo.listYears();
      const categories = await repo.listCategories();
      assert.equal(years.length, 1);
      assert.equal(categories.length, 3);
      const yearId = years[0]!.id;
      const general = categories.find((c) => c.name === "General")!;
      const specific = categories.find((c) => c.name === "Specific Event")!;
      step("seeded catalog reads back (1 year, 3 categories)");

      // --- staff ---
      await repo.upsertStaffMember({ slackUserId: "UAPPROVER", displayName: "Approver", title: "Vice President", canApprove: true, canManage: true, isPrimary: true }, "UADMIN");
      await repo.upsertStaffMember({ slackUserId: "UVP", displayName: "VP", title: null, canApprove: true, canManage: false, isPrimary: true }, "UADMIN");
      const staff = await repo.listStaff();
      assert.equal(staff.length, 2);
      assert.deepEqual(staff.filter((s) => s.isPrimary).map((s) => s.slackUserId), ["UVP"]);
      assert.equal((await repo.getPrimaryApprover())?.slackUserId, "UVP");
      await repo.upsertStaffMember({ slackUserId: "UAPPROVER", displayName: null, title: null, canApprove: true, canManage: true, isPrimary: false }, "UADMIN");
      assert.equal((await repo.getStaffMember("UAPPROVER"))?.displayName, "Approver"); // a blank name is kept
      assert.equal((await repo.getStaffMember("UAPPROVER"))?.title, null); // a blank title clears it
      await repo.upsertStaffMember({ slackUserId: "UAPPROVER", displayName: null, title: "President", canApprove: true, canManage: true, isPrimary: false }, "UADMIN");
      assert.equal((await repo.getStaffMember("UAPPROVER"))?.title, "President");
      assert.equal((await repo.listStaff()).find((m) => m.slackUserId === "UAPPROVER")?.title, "President");
      step("staff upsert keeps a single primary (transaction), keeps a blank name, and clears a blank title");

      // --- profiles through the service ---
      const saved = await volunteers.saveProfile("U1", { studentType: "uoft", firstName: "Zoë", lastName: "Müller", preferredEmail: "pref1@gmail.com", email: "zoe@mail.utoronto.ca", utorid: "mullerzo", studentNumber: "1001234567" });
      assert.equal(saved.ok, true);
      const dup = await volunteers.saveProfile("U2", { studentType: "uoft", firstName: "Some", lastName: "One", preferredEmail: "pref2@gmail.com", email: "s@mail.utoronto.ca", utorid: "mullerzo", studentNumber: "1009999999" });
      assert.equal(dup.ok, false);
      const hs = await volunteers.saveProfile("U3", { studentType: "high_school", firstName: "Aisha", lastName: "Rahman", preferredEmail: "pref3@gmail.com", email: "a@example.com", utorid: "", studentNumber: "HS200200" });
      assert.equal(hs.ok, true);
      await rejects("DB unique index on UTORid", () => repo.upsertProfile("U9", { studentType: "uoft", firstName: "Dup", lastName: "Licate", preferredEmail: "pref4@gmail.com", email: "d@x.ca", utorid: "MULLERZO", studentNumber: "1000000000" }));
      step("profiles save, and the DB blocks a duplicate UTORid");

      // --- submissions ---
      const prepared = await volunteers.prepareSubmission({
        slackSubmissionId: "V1",
        volunteerSlackUserId: "U1",
        categoryId: general.id,
        eventId: null,
        description: "Helped set up the prayer room",
        entries: [{ entryDate: "2026-11-12", hours: 2.5 }, { entryDate: "2026-11-13", hours: 1 }],
      });
      assert.equal(prepared.ok, true);
      if (!prepared.ok) throw new Error("setup");
      const created = await volunteers.createSubmission(prepared.prepared);
      assert.equal(created.created, true);
      assert.equal(created.submission.entries.length, 2);
      assert.equal(created.submission.status, "pending");
      const again = await volunteers.createSubmission({ ...prepared.prepared, id: randomUUID() });
      assert.equal(again.created, false);
      assert.equal(again.submission.id, created.submission.id);
      assert.equal(again.submission.entries.length, 2);
      step("submission + 2 entries insert atomically; a duplicate Slack id is a no-op");

      const totals = await repo.sumHoursByDate("U1", ["2026-11-12", "2026-11-13", "2026-11-14"]);
      assert.equal(totals.get("2026-11-12"), 2.5);
      assert.equal(totals.get("2026-11-14"), undefined);
      step("per-day totals query works with a date[] parameter");

      const over = await volunteers.prepareSubmission({ slackSubmissionId: "V2", volunteerSlackUserId: "U1", categoryId: general.id, eventId: null, description: "Too much", entries: [{ entryDate: "2026-11-12", hours: 22 }] });
      assert.equal(over.ok, false);
      await rejects("DB hours CHECK (25 h)", () => repo.createSubmission({ ...prepared.prepared, id: randomUUID(), slackSubmissionId: "V3", entries: [{ entryDate: "2026-11-20", hours: 25, yearId }] }));
      await rejects("entry outside any year (FK)", () => repo.createSubmission({ ...prepared.prepared, id: randomUUID(), slackSubmissionId: "V4", entries: [{ entryDate: "2026-11-21", hours: 1, yearId: randomUUID() }] }));

      await repo.setApprovalMessage(created.submission.id, "C123", "1700000000.000100");
      const reread = await volunteers.getSubmission(created.submission.id);
      assert.equal(reread?.approvalChannelId, "C123");
      assert.equal(reread?.volunteerName, "Zoë Müller");
      step("approval message ids and joins (profile/category) read back");

      // --- decisions ---
      await rejects("DB rule: disapproval needs a reason", () => repo.decideSubmission(created.submission.id, "rejected", "UAPPROVER", null));
      const approved = await volunteers.decide({ submissionId: created.submission.id, decidedBySlackUserId: "UAPPROVER", decision: "approved", note: null });
      assert.equal(approved.status, "ok");
      const second = await volunteers.decide({ submissionId: created.submission.id, decidedBySlackUserId: "UVP", decision: "rejected", note: "late" });
      assert.equal(second.status, "already_decided");
      const stranger = await volunteers.decide({ submissionId: created.submission.id, decidedBySlackUserId: "UNOBODY", decision: "approved", note: null });
      assert.equal(stranger.status, "not_authorized");
      step("approve works, the second decision loses, a stranger is refused");

      // concurrent decisions: exactly one winner
      const racing = await volunteers.prepareSubmission({ slackSubmissionId: "V5", volunteerSlackUserId: "U3", categoryId: general.id, eventId: null, description: "Race", entries: [{ entryDate: "2026-11-15", hours: 1 }] });
      assert.equal(racing.ok, true);
      if (!racing.ok) throw new Error("setup");
      await volunteers.createSubmission(racing.prepared);
      const outcomes = await Promise.all([
        volunteers.decide({ submissionId: racing.prepared.id, decidedBySlackUserId: "UAPPROVER", decision: "approved", note: null }),
        volunteers.decide({ submissionId: racing.prepared.id, decidedBySlackUserId: "UVP", decision: "rejected", note: "no" }),
      ]);
      assert.deepEqual(outcomes.map((o) => o.status).sort(), ["already_decided", "ok"]);
      step("two simultaneous decisions: exactly one wins");

      const mine = await volunteers.getMyHours("U1");
      assert.equal(mine.approvedHours, 3.5);
      step("my-hours totals");

      // --- Specific Event needs a pick-list event ---
      const event = await repo.createEvent("Iftar Night", "2026-11-20", "UEXEC");
      volunteers.invalidateFormData();
      const withEvent = await volunteers.prepareSubmission({ slackSubmissionId: "V6", volunteerSlackUserId: "U1", categoryId: specific.id, eventId: event.id, description: "Served food", entries: [{ entryDate: "2026-11-20", hours: 3 }] });
      assert.equal(withEvent.ok, true);
      if (withEvent.ok) {
        const made = await volunteers.createSubmission(withEvent.prepared);
        assert.equal(made.submission.eventName, "Iftar Night");
        await volunteers.decide({ submissionId: withEvent.prepared.id, decidedBySlackUserId: "UAPPROVER", decision: "approved", note: null });
      }
      step("specific-event submission stores and joins the event name");

      // --- reports ---
      const filters = { yearId, studentType: "uoft" as const, onlyUnsent: true, sort: "name" as const, volunteerSlackUserIds: null };
      const first = await reports.generateCombined("UAPPROVER", filters);
      assert.equal(first.status, "ok");
      if (first.status !== "ok") throw new Error("report");
      assert.equal(first.report.entryCount, 3);
      assert.equal(first.report.totalHours, 6.5);
      assert.equal(first.report.volunteerCount, 1);
      step("combined report: 3 UofT entries, 6.5 h (the high-school entry is filtered out)");

      const all = await reports.generateCombined("UAPPROVER", { ...filters, studentType: "all" });
      assert.equal(all.status === "ok" && all.report.entryCount, 4);
      const filtered = await reports.generateCombined("UAPPROVER", { ...filters, studentType: "all", volunteerSlackUserIds: ["U3"] });
      assert.equal(filtered.status === "ok" && filtered.report.entryCount, 1);
      step("student-type and volunteer filters (text[] parameter)");

      const marked = await reports.markSent(first.report.export.id, "UAPPROVER");
      assert.deepEqual(marked, { status: "done", result: { status: "ok", markedEntries: 3 } });
      const markedTwice = await reports.markSent(first.report.export.id, "UAPPROVER");
      assert.equal(markedTwice.status === "done" && markedTwice.result.status, "already_marked");
      assert.equal((await reports.generateCombined("UAPPROVER", filters)).status, "empty");
      step("mark-as-sent stamps entries once; the next unsent export is empty");

      const rowCount = await pool.query("SELECT count(*)::int AS n FROM volunteer_report_export_entries");
      assert.equal(rowCount.rows[0].n, 3 + 4 + 1 + 0);
      step("every generation recorded the entries it included (history table)");

      const later = await volunteers.prepareSubmission({ slackSubmissionId: "V7", volunteerSlackUserId: "U1", categoryId: general.id, eventId: null, description: "Later", entries: [{ entryDate: "2026-12-01", hours: 2 }] });
      if (later.ok) {
        await volunteers.createSubmission(later.prepared);
        await volunteers.decide({ submissionId: later.prepared.id, decidedBySlackUserId: "UAPPROVER", decision: "approved", note: null });
      }
      const next = await reports.generateCombined("UAPPROVER", filters);
      assert.equal(next.status === "ok" && next.report.entryCount, 1);
      step("a later approval shows up in the next unsent export");

      const letters = await reports.generateLetterheads("UAPPROVER", { ...filters, volunteerSlackUserIds: ["U1", "U9"] }, new Map([["U1", "<@U1>"], ["U9", "<@U9>"]]));
      assert.equal(letters.status, "ok");
      if (letters.status === "ok") {
        assert.equal(letters.report.files.length, 1);
        assert.deepEqual(letters.report.skippedVolunteers, ["<@U9>"]);
      }
      step("letterhead export includes already-sent hours and lists volunteers with none");

      // --- admin writes ---
      const category = await repo.createCategory("Outreach", false);
      assert.equal((await repo.updateCategory(category.id, { name: "Community Outreach", isActive: false }))?.isActive, false);
      assert.equal((await repo.updateCategory(category.id, { isActive: true }))?.name, "Community Outreach");
      await rejects("case-insensitive duplicate category", () => repo.createCategory("community outreach", false));
      assert.equal(await repo.setEventActive(event.id, false), true);
      const year2 = await repo.createYear("2027/28 Volunteer Year", "2027-09-01", "2028-08-31");
      assert.equal(year2.startDate, "2027-09-01");
      assert.equal(await repo.removeStaffMember("UVP"), true);
      step("admin writes: category create/update, event toggle, year create, staff remove");

      // --- on-behalf entry ---
      const behalfProfile = await volunteers.saveProfile("UNEWV", { studentType: "uoft", firstName: "Newly", lastName: "Added", preferredEmail: "pref5@gmail.com", email: "newly@mail.utoronto.ca", utorid: "newlyadd", studentNumber: "1005550001" }, "UAPPROVER");
      assert.equal(behalfProfile.ok, true);
      const behalf = await volunteers.prepareSubmission({ slackSubmissionId: "VOB1", volunteerSlackUserId: "UNEWV", submittedBySlackUserId: "UAPPROVER", categoryId: general.id, eventId: null, description: "Entered by an exec", entries: [{ entryDate: "2026-12-01", hours: 3 }] });
      assert.equal(behalf.ok, true);
      if (!behalf.ok) throw new Error("setup");
      const behalfCreated = await volunteers.createSubmission(behalf.prepared);
      assert.equal(behalfCreated.submission.volunteerSlackUserId, "UNEWV");
      assert.equal(behalfCreated.submission.submittedBySlackUserId, "UAPPROVER");
      const behalfRows = (await volunteers.getMyHours("UNEWV")).rows;
      assert.equal(behalfRows[0]?.enteredByStaff, true);
      const selfRows = (await volunteers.getMyHours("U1")).rows;
      assert.ok(selfRows.every((row) => row.enteredByStaff === false));
      await rejects("submitted_by is required by the DB", () => repo.createSubmission({ ...behalf.prepared, id: randomUUID(), slackSubmissionId: "VOB2", submittedBySlackUserId: null as unknown as string }));
      step("on-behalf submission: volunteer keeps the hours, exec recorded as submitter, shown in my-hours");

      // --- volunteer without Slack + search ---
      const extKey = volunteers.newExternalVolunteerKey();
      const extSaved = await volunteers.saveProfile(extKey, { studentType: "high_school", firstName: "Zora", lastName: "100%_Smith", preferredEmail: "pref6@gmail.com", email: "zora@example.com", utorid: "", studentNumber: "HS300300" }, "UAPPROVER");
      assert.equal(extSaved.ok, true);
      const extPrepared = await volunteers.prepareSubmission({ slackSubmissionId: "VEXT1", volunteerSlackUserId: extKey, submittedBySlackUserId: "UAPPROVER", categoryId: general.id, eventId: null, description: "Entered for someone without Slack", entries: [{ entryDate: "2026-12-02", hours: 2 }] });
      assert.equal(extPrepared.ok, true);
      if (!extPrepared.ok) throw new Error("setup");
      const extCreated = await volunteers.createSubmission(extPrepared.prepared);
      assert.equal(extCreated.submission.volunteerSlackUserId, extKey);
      assert.equal(extCreated.submission.volunteerName, "Zora 100%_Smith");
      step("a volunteer with a placeholder key saves a profile and a submission");
      const byName = await repo.searchProfiles("zora", 10);
      assert.deepEqual(byName.map((p) => p.slackUserId), [extKey]);
      assert.equal((await repo.searchProfiles("EXAMPLE.COM", 10)).length, 2); // Aisha and Zora, case-insensitive
      assert.equal((await repo.searchProfiles("mullerzo", 10)).map((p) => p.fullName).join(), "Zoë Müller");
      assert.equal((await repo.searchProfiles("100%", 10)).length, 1); // literal percent sign
      assert.equal((await repo.searchProfiles("%", 10)).length, 1);     // not a wildcard: only the name with a real %
      assert.equal((await repo.searchProfiles("z_", 10)).length, 0);    // not a wildcard either
      assert.equal((await repo.searchProfiles("zzzz", 10)).length, 0);
      assert.equal((await repo.searchProfiles("e", 2)).length, 2);       // limit honoured
      step("profile search matches name/UTORid/email, treats % and _ literally, honours the limit");
      const staffAfter = await volunteers.searchVolunteers("UAPPROVER", "zora");
      assert.equal(staffAfter.length, 1);
      assert.equal((await volunteers.searchVolunteers("UNOBODY", "zora")).length, 0);
      step("search is limited to execs");

      // --- auto-approval on entry, student key uniqueness, relink cascade ---
      assert.equal(behalfCreated.submission.status, "approved");
      assert.equal(behalfCreated.submission.decidedBySlackUserId, "UAPPROVER");
      assert.ok(behalfCreated.submission.decidedAt);
      assert.equal(extCreated.submission.status, "approved");
      const afterEntry = await volunteers.decide({ submissionId: behalfCreated.submission.id, decidedBySlackUserId: "UAPPROVER", decision: "rejected", note: "no" });
      assert.equal(afterEntry.status, "already_decided");
      step("an exec's on-behalf entry is saved already approved (status, decided_by, decided_at), and can't be decided again");

      assert.equal(extSaved.ok && extSaved.profile.fullName, "Zora 100%_Smith"); // generated full_name column
      await rejects("DB unique (student type, student number)", () => repo.upsertProfile("UDUPNUM", { studentType: "high_school", firstName: "Dup", lastName: "Num", preferredEmail: "pref7@gmail.com", email: "dn@x.ca", utorid: null, studentNumber: "hs300300" }));
      // the same number under another type is a different person
      await repo.upsertProfile("UOTHERTYPE", { studentType: "other_university", firstName: "Other", lastName: "Type", preferredEmail: "pref8@gmail.com", email: "ot@x.ca", utorid: null, studentNumber: "HS300300" });
      step("student number is unique per student type (case-insensitive), not globally");

      // Relink: Slack user signs in with matching details; submissions follow the key.
      const linkedBefore = (await volunteers.getMyHours(extKey)).rows.length;
      assert.equal(linkedBefore, 1);
      const linked = await volunteers.saveProfile("UZORA00001", { studentType: "high_school", firstName: "Zora", lastName: "100%_Smith", preferredEmail: "pref9@gmail.com", email: "ZORA@example.com", utorid: "", studentNumber: "hs300300" });
      assert.equal(linked.ok && linked.linkedFrom, extKey);
      assert.equal(await repo.getProfile(extKey), null);
      assert.equal((await volunteers.getMyHours("UZORA00001")).rows.length, 1);
      assert.equal((await volunteers.getMyHours(extKey)).rows.length, 0);
      const moved = await repo.getSubmission(extCreated.submission.id);
      assert.equal(moved?.volunteerSlackUserId, "UZORA00001");
      assert.equal(moved?.volunteerName, "Zora 100%_Smith");
      step("relink re-keys the profile and cascades to its submissions (ON UPDATE CASCADE)");

      assert.equal(await repo.relinkProfile(extKey, "UANOTHER01"), false); // already moved
      assert.equal(await repo.relinkProfile("UZORA00001", "UANOTHER02"), false); // real Slack IDs are never re-keyed
      const raceKey = volunteers.newExternalVolunteerKey();
      await repo.upsertProfile(raceKey, { studentType: "uoft", firstName: "Race", lastName: "R", preferredEmail: "pref10@gmail.com", email: "r@x.ca", utorid: "racer1", studentNumber: "1005550007" });
      const claims = await Promise.allSettled([repo.relinkProfile(raceKey, "URACE00001"), repo.relinkProfile(raceKey, "URACE00002")]);
      const wins = claims.filter((c) => c.status === "fulfilled" && c.value === true).length;
      assert.equal(wins, 1);
      step("two simultaneous claims of the same record: exactly one wins");
      const dupKey = volunteers.newExternalVolunteerKey();
      await repo.upsertProfile(dupKey, { studentType: "uoft", firstName: "Dup", lastName: "T", preferredEmail: "pref11@gmail.com", email: "dt@x.ca", utorid: "duptarget", studentNumber: "1007770001" });
      await rejects("relink onto a Slack ID that already has a profile", () => repo.relinkProfile(dupKey, "U1"));
      assert.ok(await repo.getProfile(dupKey)); // nothing changed
      step("a failed relink leaves the record untouched");

      // --- editing and deleting requests (the atomic edit statement, audit, locking) ---
      const ev = await volunteers.saveProfile("UEDITV", { studentType: "uoft", firstName: "Edit", lastName: "Target", preferredEmail: "edit@gmail.com", email: "edit@mail.utoronto.ca", utorid: "edittarget", studentNumber: "1008880001" });
      assert.equal(ev.ok, true);
      const baseInput = { volunteerSlackUserId: "UEDITV", categoryId: general.id, eventId: null, description: "Original", entries: [{ entryDate: "2027-01-10", hours: 2 }, { entryDate: "2027-01-11", hours: 3 }] };
      const first1 = await volunteers.prepareSubmission({ ...baseInput, slackSubmissionId: "VED1" });
      assert.equal(first1.ok, true);
      if (!first1.ok) throw new Error("setup");
      const editId = first1.prepared.id;
      await volunteers.createSubmission(first1.prepared);
      const entryRows = async () => (await pool.query("SELECT id, entry_date::text AS d, hours::text AS h FROM volunteer_entries WHERE submission_id = $1 ORDER BY entry_date", [editId])).rows;
      const before1 = await entryRows();
      const keptEntryId = before1[1].id;   // 2027-01-11 stays across edits
      const droppedEntryId = before1[0].id; // 2027-01-10 gets removed

      const editAs = async (editor: string, overrides: Record<string, unknown>) => {
        const prepared = await volunteers.prepareSubmission({ ...baseInput, slackSubmissionId: "VEDx", editingSubmissionId: editId, submittedBySlackUserId: editor, ...overrides } as never);
        if (!prepared.ok) throw new Error("prepare failed: " + JSON.stringify(prepared.issues));
        return volunteers.applyEdit(prepared.prepared, editor);
      };

      // volunteer edits own pending request: hours, a removed date, an added date; kept date keeps its row
      const e1 = await editAs("UEDITV", { entries: [{ entryDate: "2027-01-11", hours: 4 }, { entryDate: "2027-01-12", hours: 1 }], description: "Fixed" });
      assert.equal(e1.status, "ok");
      const after1 = await entryRows();
      assert.deepEqual(after1.map((r) => [r.d, r.h]), [["2027-01-11", "4.00"], ["2027-01-12", "1.00"]]);
      assert.equal(after1[0].id, keptEntryId);
      assert.ok(!after1.some((r) => r.id === droppedEntryId));
      assert.equal((await repo.getSubmission(editId))?.description, "Fixed");
      assert.equal((await repo.getSubmission(editId))?.status, "pending");
      step("edit statement: hours changed, date removed, date added; the kept date keeps its entry row");

      // approve, then the volunteer edits again: back to pending, decision cleared (DB check constraint holds)
      await volunteers.decide({ submissionId: editId, decidedBySlackUserId: "UAPPROVER", decision: "approved", note: null });
      const e2 = await editAs("UEDITV", { entries: [{ entryDate: "2027-01-11", hours: 5 }, { entryDate: "2027-01-12", hours: 1 }], description: "Fixed" });
      assert.equal(e2.status, "ok");
      const s2 = await repo.getSubmission(editId);
      assert.equal(s2?.status, "pending");
      assert.equal(s2?.decidedBySlackUserId, null);
      assert.equal(s2?.editedBySlackUserId, "UEDITV");
      step("a volunteer's edit of approved hours sends them back to pending (decided_by/decided_at cleared)");

      // exec edit: approved on the spot, volunteer unchanged
      const e3 = await editAs("UAPPROVER", { entries: [{ entryDate: "2027-01-11", hours: 5 }, { entryDate: "2027-01-12", hours: 1.5 }], description: "Exec fixed" });
      assert.equal(e3.status, "ok");
      const s3 = await repo.getSubmission(editId);
      assert.equal(s3?.status, "approved");
      assert.equal(s3?.decidedBySlackUserId, "UAPPROVER");
      assert.equal(s3?.volunteerSlackUserId, "UEDITV");
      assert.equal(s3?.editedBySlackUserId, "UAPPROVER");
      step("an exec's edit is approved immediately and stays with the volunteer");

      // no-op edit does not reopen approved hours
      const e4 = await editAs("UEDITV", { entries: [{ entryDate: "2027-01-11", hours: 5 }, { entryDate: "2027-01-12", hours: 1.5 }], description: "Exec fixed" });
      assert.equal(e4.status, "unchanged");
      assert.equal((await repo.getSubmission(editId))?.status, "approved");
      step("an edit that changes nothing is a no-op and doesn't reopen approved hours");

      // audit trail
      const audit = (await pool.query("SELECT changed_by_slack_user_id AS by, action, before_snapshot AS b, after_snapshot AS a FROM volunteer_submission_changes WHERE submission_id = $1 ORDER BY changed_at, id", [editId])).rows;
      assert.equal(audit.length, 3);
      assert.deepEqual(audit.map((r) => r.by), ["UEDITV", "UEDITV", "UAPPROVER"]);
      assert.equal(audit[0].b.description, "Original");
      assert.equal(audit[0].b.entries.length, 2);
      assert.equal(audit[0].a.description, "Fixed");
      assert.equal(audit[2].b.status, "pending");
      assert.equal(audit[2].a.status, "approved");
      assert.equal(audit[2].a.entries[1].hours, 1.5);
      step("every real edit left an audit row with before and after (and the no-op left none)");

      // 24h/day cap ignores the request's own hours but counts everything else
      const other = await volunteers.prepareSubmission({ ...baseInput, slackSubmissionId: "VED2", entries: [{ entryDate: "2027-01-20", hours: 20 }] });
      assert.equal(other.ok, true);
      if (!other.ok) throw new Error("setup");
      await volunteers.createSubmission(other.prepared);
      const capOk = await volunteers.prepareSubmission({ ...baseInput, slackSubmissionId: "VEDc", editingSubmissionId: editId, entries: [{ entryDate: "2027-01-11", hours: 24 }] });
      assert.equal(capOk.ok, true); // its own 5 h on the 11th don't count against it
      const capBad = await volunteers.prepareSubmission({ ...baseInput, slackSubmissionId: "VEDd", editingSubmissionId: editId, entries: [{ entryDate: "2027-01-20", hours: 5 }] });
      assert.equal(capBad.ok, false); // another request already has 20 h that day
      step("daily cap excludes the edited request's own hours (SQL exclusion) but counts others");

      // report history: kept dates keep their link to earlier exports, dropped dates lose it
      const gen = await reports.generateCombined("UAPPROVER", { ...filters, onlyUnsent: false, volunteerSlackUserIds: ["UEDITV"] });
      assert.equal(gen.status, "ok");
      if (gen.status !== "ok") throw new Error("report");
      const exportId = gen.report.export.id;
      const inExport = async (entryId: string) => Number((await pool.query("SELECT count(*) AS c FROM volunteer_report_export_entries WHERE export_id = $1 AND entry_id = $2", [exportId, entryId])).rows[0].c);
      assert.equal(await inExport(keptEntryId), 1);
      const e5 = await editAs("UAPPROVER", { entries: [{ entryDate: "2027-01-11", hours: 6 }], description: "Exec fixed" });
      assert.equal(e5.status, "ok");
      assert.equal(await inExport(keptEntryId), 1); // the kept date's entry row, and its report history, survive
      step("editing keeps the report history of dates that stay");

      // CCR lock: once an export is marked sent, the request can't be edited or deleted
      const sentOutcome = await reports.markSent(exportId, "UAPPROVER");
      assert.equal(sentOutcome.status, "done");
      const locked = await editAs("UAPPROVER", { entries: [{ entryDate: "2027-01-11", hours: 7 }], description: "Too late" });
      assert.equal(locked.status, "locked");
      assert.equal((await volunteers.deleteRequest("UAPPROVER", editId)).status, "locked");
      assert.equal((await entryRows())[0].h, "6.00");
      assert.equal((await repo.getSubmission(editId))?.description, "Exec fixed");
      assert.equal((await volunteers.getRequestForEdit("UEDITV", editId)).status, "locked");
      step("hours already sent to CCR lock the request: edit and delete are refused and nothing changed");

      // The SQL guard itself, bypassing the service's own check. It is the backstop
      // if a request is marked sent between the service's check and the write.
      const auditCount = async () =>
        Number((await pool.query("SELECT count(*) AS c FROM volunteer_submission_changes")).rows[0].c);
      const auditBefore = await auditCount();
      const rawSnapshot = { categoryId: general.id, eventId: null, description: "x", status: "approved" as const, entries: [] };
      const rawEdit = await repo.updateSubmission(
        { submissionId: editId, categoryId: general.id, eventId: null, description: "Raced past the service check", entries: [{ entryDate: "2027-01-11", hours: 8, yearId }], editedBySlackUserId: "UAPPROVER", approvedBySlackUserId: "UAPPROVER" },
        { before: rawSnapshot, after: rawSnapshot },
      );
      assert.equal(rawEdit.status, "locked");
      assert.equal((await entryRows())[0].h, "6.00");
      assert.equal((await repo.getSubmission(editId))?.description, "Exec fixed");
      assert.equal((await repo.deleteSubmission(editId, "UAPPROVER", rawSnapshot)).status, "locked");
      assert.ok(await repo.getSubmission(editId));
      assert.equal(await auditCount(), auditBefore); // a refused change writes no audit row
      step("the database itself refuses to edit or delete CCR-sent hours, and writes no audit row for the attempt");

      // delete: exec only, audited, cascades to entries
      const doomed = await volunteers.prepareSubmission({ ...baseInput, slackSubmissionId: "VED3", entries: [{ entryDate: "2027-02-01", hours: 2 }, { entryDate: "2027-02-02", hours: 1 }] });
      assert.equal(doomed.ok, true);
      if (!doomed.ok) throw new Error("setup");
      await volunteers.createSubmission(doomed.prepared);
      const doomedId = doomed.prepared.id;
      assert.equal((await volunteers.deleteRequest("UEDITV", doomedId)).status, "not_allowed");
      assert.ok(await repo.getSubmission(doomedId));
      const del = await volunteers.deleteRequest("UAPPROVER", doomedId);
      assert.equal(del.status, "ok");
      assert.equal(await repo.getSubmission(doomedId), null);
      assert.equal(Number((await pool.query("SELECT count(*) AS c FROM volunteer_entries WHERE submission_id = $1", [doomedId])).rows[0].c), 0);
      const delAudit = (await pool.query("SELECT changed_by_slack_user_id AS by, before_snapshot AS b, after_snapshot AS a FROM volunteer_submission_changes WHERE submission_id = $1 AND action = 'delete'", [doomedId])).rows;
      assert.equal(delAudit.length, 1);
      assert.equal(delAudit[0].by, "UAPPROVER");
      assert.equal(delAudit[0].b.entries.length, 2);
      assert.equal(delAudit[0].a, null);
      assert.equal((await volunteers.deleteRequest("UAPPROVER", doomedId)).status, "not_found");
      step("delete: exec only, cascades to its dates, and the audit row survives the deleted request");

      assert.equal((await repo.updateSubmission({ submissionId: randomUUID(), categoryId: general.id, eventId: null, description: "x", entries: [{ entryDate: "2027-01-11", hours: 1, yearId }], editedBySlackUserId: "UAPPROVER", approvedBySlackUserId: "UAPPROVER" }, { before: { categoryId: general.id, eventId: null, description: "", status: "pending", entries: [] }, after: { categoryId: general.id, eventId: null, description: "x", status: "approved", entries: [] } })).status, "not_found");
      const listed = await repo.listSubmissionsForVolunteer("UEDITV", 10);
      assert.equal(listed.length, 2);
      assert.equal(listed[0]?.entries.every((entry) => entry.ccrSentAt !== undefined), true);
      step("updating a missing request is not_found; listing a volunteer's requests works");

      // --- approval buttons are refused once the request was edited (version guard) ---
      const vv = await volunteers.saveProfile("UVERSION1", { studentType: "uoft", firstName: "Ver", lastName: "Sion", preferredEmail: "v@gmail.com", email: "v@mail.utoronto.ca", utorid: "versionone", studentNumber: "1009990001" });
      assert.equal(vv.ok, true);
      const verPrepared = await volunteers.prepareSubmission({ slackSubmissionId: "VVER1", volunteerSlackUserId: "UVERSION1", categoryId: general.id, eventId: null, description: "Versioned", entries: [{ entryDate: "2027-03-01", hours: 2 }] });
      assert.equal(verPrepared.ok, true);
      if (!verPrepared.ok) throw new Error("setup");
      const verCreated = await volunteers.createSubmission(verPrepared.prepared);
      const verId = verCreated.submission.id;
      assert.equal(verCreated.submission.version, 0);
      const editVer = await volunteers.prepareSubmission({ slackSubmissionId: "VVER2", volunteerSlackUserId: "UVERSION1", editingSubmissionId: verId, categoryId: general.id, eventId: null, description: "Versioned", entries: [{ entryDate: "2027-03-01", hours: 9 }] });
      assert.equal(editVer.ok, true);
      if (!editVer.ok) throw new Error("setup");
      assert.equal((await volunteers.applyEdit(editVer.prepared, "UVERSION1")).status, "ok");
      assert.equal((await repo.getSubmission(verId))?.version, 1);
      const staleApprove = await volunteers.decide({ submissionId: verId, decidedBySlackUserId: "UAPPROVER", decision: "approved", note: null, expectedVersion: 0 });
      assert.equal(staleApprove.status, "stale");
      const staleReject = await volunteers.decide({ submissionId: verId, decidedBySlackUserId: "UAPPROVER", decision: "rejected", note: "no", expectedVersion: 0 });
      assert.equal(staleReject.status, "stale");
      assert.equal((await repo.getSubmission(verId))?.status, "pending");
      const freshApprove = await volunteers.decide({ submissionId: verId, decidedBySlackUserId: "UAPPROVER", decision: "approved", note: null, expectedVersion: 1 });
      assert.equal(freshApprove.status, "ok");
      assert.equal((await volunteers.decide({ submissionId: verId, decidedBySlackUserId: "UAPPROVER", decision: "rejected", note: "no", expectedVersion: 1 })).status, "already_decided");
      step("a click on a card shown before an edit is refused (stale); the updated card works; decided requests stay decided");

      // --- year management: totals, the guarded edit, and delete ---
      volunteers.invalidateFormData();
      await repo.createYear("Mgmt Year 2027/28", "2040-09-01", "2041-03-15");
      const yearMgmt = (await repo.listYears()).find((y) => y.label.startsWith("Mgmt Year"))!;
      assert.equal((await repo.listYearStats()).find((stat) => stat.yearId === yearMgmt.id), undefined);
      step("a year with nothing logged has no totals");

      const movedYear = await repo.updateYear(yearMgmt.id, "Mgmt Year renamed", "2040-09-02", "2041-03-14");
      assert.deepEqual(movedYear, {
        status: "updated",
        year: { id: yearMgmt.id, label: "Mgmt Year renamed", startDate: "2040-09-02", endDate: "2041-03-14", isDefault: false },
      });
      assert.equal((await repo.updateYear(randomUUID(), "x", "2030-01-01", "2030-02-01")).status, "not_found");
      await rejects("a year label that already exists, ignoring case", () =>
        repo.updateYear(yearMgmt.id, "2026/27 volunteer year", "2040-09-02", "2041-03-14"),
      );
      await rejects("a year that ends before it starts", () =>
        repo.updateYear(yearMgmt.id, "Mgmt Year renamed", "2041-03-14", "2040-09-02"),
      );
      step("a year can be renamed and moved, and the database refuses a duplicate label or reversed dates");

      for (const [slackUserId, utorid, studentNumber] of [
        ["UYEAR00001", "ytotalsa", "1004440011"],
        ["UYEAR00002", "ytotalsb", "1004440012"],
      ] as const) {
        const saved = await volunteers.saveProfile(slackUserId, { studentType: "uoft", firstName: "Year", lastName: utorid === "ytotalsa" ? "Alpha" : "Beta", preferredEmail: `${utorid}@gmail.com`, email: `${utorid}@mail.utoronto.ca`, utorid, studentNumber });
        assert.equal(saved.ok, true, JSON.stringify(saved));
      }
      const logIn2027 = async (slackSubmissionId: string, volunteer: string, entryDate: string, hours: number) => {
        const prepared = await volunteers.prepareSubmission({ slackSubmissionId, volunteerSlackUserId: volunteer, categoryId: general.id, eventId: null, description: "Year totals", entries: [{ entryDate, hours }] });
        assert.equal(prepared.ok, true);
        if (!prepared.ok) throw new Error("setup");
        return (await volunteers.createSubmission(prepared.prepared)).submission.id;
      };
      await logIn2027("VYEAR1", "UYEAR00001", "2040-10-01", 1.5); // stays pending
      const approvedId = await logIn2027("VYEAR2", "UYEAR00002", "2040-10-02", 4);
      const rejectedId = await logIn2027("VYEAR3", "UYEAR00001", "2040-10-03", 3);
      assert.equal((await volunteers.decide({ submissionId: approvedId, decidedBySlackUserId: "UAPPROVER", decision: "approved", note: null })).status, "ok");
      assert.equal((await volunteers.decide({ submissionId: rejectedId, decidedBySlackUserId: "UAPPROVER", decision: "rejected", note: "no" })).status, "ok");
      await pool.query("UPDATE volunteer_entries SET ccr_sent_at = now() WHERE entry_date = '2040-10-02'");
      assert.deepEqual((await repo.listYearStats()).find((stat) => stat.yearId === yearMgmt.id), {
        yearId: yearMgmt.id,
        volunteers: 2,
        approvedHours: 4,
        pendingHours: 1.5,
        rejectedHours: 3,
        sentHours: 4,
      });
      step("a year's totals split approved, pending, disapproved and sent hours, and count distinct volunteers");

      const stranded = await repo.updateYear(yearMgmt.id, "Mgmt Year renamed", "2040-10-02", "2041-03-14");
      assert.deepEqual(stranded, { status: "entries_outside", count: 1 });
      assert.equal((await repo.listYears()).find((y) => y.id === yearMgmt.id)?.startDate, "2040-09-02");
      assert.equal((await repo.updateYear(yearMgmt.id, "Mgmt Year renamed", "2040-09-02", "2040-10-02")).status, "entries_outside");
      assert.equal((await repo.updateYear(yearMgmt.id, "Renamed again", "2040-10-01", "2041-03-14")).status, "updated");
      step("dates can't move past a logged date (the guard is inside the UPDATE); other changes still work");

      assert.equal(await repo.deleteYear(yearMgmt.id), "in_use");
      assert.equal(await repo.deleteYear(randomUUID()), "not_found");
      await repo.createYear("Mgmt Spare Year", "2030-09-01", "2031-03-15");
      const spare = (await repo.listYears()).find((y) => y.label.startsWith("Mgmt Spare"))!;
      assert.equal(await repo.deleteYear(spare.id), "deleted");
      assert.equal((await repo.listYears()).some((y) => y.id === spare.id), false);
      step("a year with hours can't be deleted; an empty one can");

      const reportYear = await repo.createYear("Mgmt Report Year", "2031-09-01", "2032-03-15");
      await repo.createExport({ generatedBySlackUserId: "UAPPROVER", yearId: reportYear.id, kind: "combined", filters: { yearId: reportYear.id, studentType: "all", onlyUnsent: false, sort: "name", volunteerSlackUserIds: null }, entryIds: [], totalHours: 0 });
      assert.equal(await repo.deleteYear(reportYear.id), "in_use");
      step("a year a report was generated for can't be deleted either");

      // --- the default year ---
      const defaults = async () => (await repo.listYears()).filter((y) => y.isDefault).map((y) => y.id);
      assert.deepEqual(await defaults(), [], "the migration must not choose a default");
      assert.equal(await repo.setDefaultYear(randomUUID()), false);
      assert.deepEqual(await defaults(), [], "an unknown year changes nothing");
      assert.equal(await repo.setDefaultYear(yearId), true);
      assert.deepEqual(await defaults(), [yearId]);
      assert.equal(await repo.setDefaultYear(yearMgmt.id), true);
      assert.deepEqual(await defaults(), [yearMgmt.id], "a new default replaces the old one");
      assert.equal(await repo.setDefaultYear(randomUUID()), false);
      assert.deepEqual(await defaults(), [yearMgmt.id], "a stale id must not wipe the current default");
      await rejects("two default years at once", () => pool.query("UPDATE volunteer_years SET is_default = true"));
      assert.deepEqual(await defaults(), [yearMgmt.id], "the database itself refuses a second default");
      const renamedDefault = await repo.updateYear(yearMgmt.id, "Mgmt default renamed", "2040-10-01", "2041-03-14");
      assert.equal(renamedDefault.status === "updated" && renamedDefault.year.isDefault, true, "editing a year keeps its default flag");
      assert.equal((await repo.createYear("Mgmt Not Default", "2033-09-01", "2034-03-15")).isDefault, false);
      assert.equal(await repo.setDefaultYear(null), true);
      assert.deepEqual(await defaults(), []);
      step("one default year at most; replaced, kept on edit, cleared, and enforced by the database");

      const iftar = await repo.createEvent("Fall Iftar", "2027-11-20", "UAPPROVER");
      const renamed = await repo.updateEvent(iftar.id, "Community Iftar", null);
      assert.deepEqual(renamed, { id: iftar.id, name: "Community Iftar", eventDate: null, isActive: true });
      assert.equal(await repo.updateEvent(randomUUID(), "x", null), null);
      step("an event's name and date can be edited, including clearing the date");

      // --- the approvers' queue ---
      const pendingTotal = Number((await pool.query("SELECT count(*)::int AS n FROM volunteer_submissions WHERE status = 'pending'")).rows[0].n);
      assert.ok(pendingTotal >= 2, "the scenario leaves several pending requests");
      assert.equal(await repo.countPendingSubmissions(), pendingTotal);
      const queueAll = await repo.listPendingSubmissions(1000);
      assert.equal(queueAll.length, pendingTotal);
      assert.ok(queueAll.every((request) => request.status === "pending" && request.entries.length > 0 && request.volunteerName.length > 0));
      assert.deepEqual(
        queueAll.map((request) => request.submittedAt),
        [...queueAll.map((request) => request.submittedAt)].sort(),
        "oldest first",
      );
      const queuePage = await repo.listPendingSubmissions(2);
      assert.deepEqual(queuePage.map((request) => request.id), queueAll.slice(0, 2).map((request) => request.id));
      const toDecide = queueAll[0]!;
      assert.equal((await volunteers.decide({ submissionId: toDecide.id, decidedBySlackUserId: "UAPPROVER", decision: "approved", note: null })).status, "ok");
      assert.equal(await repo.countPendingSubmissions(), pendingTotal - 1);
      assert.ok(!(await repo.listPendingSubmissions(1000)).some((request) => request.id === toDecide.id));
      step("the pending queue lists only pending requests, oldest first, with a page limit and an exact count");


    } catch (error) {
      throw new Error(
        `Failed after step "${lastStep}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
});
