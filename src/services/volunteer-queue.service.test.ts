import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryVolunteerRepository } from "../repositories/in-memory-volunteer.repository.js";
import { PENDING_QUEUE_PAGE, VolunteerService } from "./volunteer.service.js";

const YEAR = { id: "11111111-1111-4111-8111-111111111111", label: "2026/27", startDate: "2026-09-01", endDate: "2027-03-15" };
const GENERAL = { id: "22222222-2222-4222-8222-222222222222", name: "General", requiresEvent: false, isActive: true, sortOrder: 1 };

function setup() {
  const repository = new InMemoryVolunteerRepository({
    years: [YEAR],
    categories: [GENERAL],
    staff: [
      { slackUserId: "UAPPROVER", displayName: "A", title: null, canApprove: true, canManage: false, isPrimary: true },
      { slackUserId: "UMANAGER", displayName: "M", title: null, canApprove: false, canManage: true, isPrimary: false },
    ],
  });

  return { repository, volunteers: new VolunteerService(repository, new Set(["UADMIN"])) };
}

async function submit(
  volunteers: VolunteerService,
  slackUserId: string,
  number: string,
  date: string,
): Promise<string> {
  await volunteers.saveProfile(slackUserId, {
    studentType: "uoft", firstName: "Vol", lastName: "Unteer", preferredEmail: `${number}@gmail.com`,
    email: `${number}@mail.utoronto.ca`, utorid: `vol${number}`, studentNumber: number.padStart(10, "1"),
  });
  const prepared = await volunteers.prepareSubmission({
    slackSubmissionId: `V${slackUserId}${date}`, volunteerSlackUserId: slackUserId, categoryId: GENERAL.id,
    eventId: null, description: "Helped", entries: [{ entryDate: date, hours: 2 }],
  });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("setup");

  return (await volunteers.createSubmission(prepared.prepared)).submission.id;
}

describe("the approvers' queue", () => {
  it("lists pending requests, oldest first, and leaves out decided ones", async () => {
    const { volunteers } = setup();
    const first = await submit(volunteers, "UVOLONE01", "100000001", "2026-11-01");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await submit(volunteers, "UVOLTWO02", "100000002", "2026-11-02");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const third = await submit(volunteers, "UVOLTHREE3", "100000003", "2026-11-03");
    await volunteers.decide({ submissionId: second, decidedBySlackUserId: "UAPPROVER", decision: "approved", note: null });

    const queue = await volunteers.getPendingQueue("UAPPROVER");

    assert.deepEqual(queue?.requests.map((request) => request.id), [first, third]);
    assert.equal(queue?.total, 2);
  });

  it("lets approvers, managers and admins look, and only approvers approve", async () => {
    const { volunteers } = setup();
    await submit(volunteers, "UVOLONE01", "100000001", "2026-11-01");

    assert.equal((await volunteers.getPendingQueue("UAPPROVER"))?.canApprove, true);
    assert.equal((await volunteers.getPendingQueue("UMANAGER"))?.canApprove, false);
    assert.equal((await volunteers.getPendingQueue("UADMIN"))?.canApprove, false);
    assert.equal(await volunteers.getPendingQueue("USTRANGER"), null);
    assert.equal(await volunteers.getPendingQueue("UVOLONE01"), null);
  });

  it("shows one page but counts them all", async () => {
    const { volunteers } = setup();

    for (let day = 1; day <= PENDING_QUEUE_PAGE + 3; day += 1) {
      const date = `2026-10-${String(day).padStart(2, "0")}`;
      await submit(volunteers, "UVOLONE01", "100000001", date.length === 10 ? date : "2026-10-01");
    }

    const queue = await volunteers.getPendingQueue("UAPPROVER");

    assert.equal(queue?.requests.length, PENDING_QUEUE_PAGE);
    assert.equal(queue?.total, PENDING_QUEUE_PAGE + 3);
  });
});
