import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { App } from "@slack/bolt";
import { InMemoryVolunteerRepository } from "../repositories/in-memory-volunteer.repository.js";
import { VolunteerAdminService } from "../services/volunteer-admin.service.js";
import { VolunteerReportService } from "../services/volunteer-report.service.js";
import { VolunteerService } from "../services/volunteer.service.js";
import type { VolunteerServices } from "../volunteer-application.js";
import { hubActionIds } from "./volunteer-hub-views.js";
import { createVolunteerSlackApp } from "./volunteer-app.js";
import { checkView } from "./volunteer-view-limits.testkit.js";
import { actionIds, blockIds, callbackIds } from "./volunteer-views.js";

/**
 * Drives the real app wiring (every command, button and form handler) with an
 * in-memory database and a fake Slack client, the way Slack would: a button
 * press, a form submission. It catches what the screen-level tests can't: a
 * handler that was never registered, or a button that leads nowhere.
 */
type Handler = (args: Record<string, unknown>) => Promise<unknown>;

const YEAR = { id: "11111111-1111-4111-8111-111111111111", label: "2026/27 Volunteer Year", startDate: "2026-09-01", endDate: "2027-03-15", isDefault: false };
const GENERAL = { id: "22222222-2222-4222-8222-222222222222", name: "General", requiresEvent: false, isActive: true, sortOrder: 1 };
const ADMIN = "UADMIN0001";
const VOLUNTEER = "UVOL000001";
const OTHER = "UOTHER0001";
const APPROVER = "UAPPROVER01";
const MANAGER = "UMANAGER01";

const handlers = {
  commands: new Map<string, Handler>(),
  actions: [] as Array<{ matcher: string | RegExp; handler: Handler }>,
  views: new Map<string, Handler>(),
  options: new Map<string, Handler>(),
};
const patched = ["command", "action", "view", "options"] as const;
const originals = new Map<string, unknown>();

type Update = { viewId: string; hash?: string; view: { title?: { text: string }; blocks?: unknown[]; private_metadata?: string; callback_id?: string } };
const updates: Update[] = [];
/** Every screen the handlers sent during the whole run (never cleared). */
const everyScreen: Array<Update["view"]> = [];
const dms: Array<{ channel: string; text: string }> = [];

const client = {
  views: {
    update: async (args: { view_id: string; hash?: string; view: Update["view"] }) => {
      everyScreen.push(args.view);
      updates.push({ viewId: args.view_id, ...(args.hash ? { hash: args.hash } : {}), view: args.view });
      return {};
    },
    open: async () => ({ view: { id: "VOPEN" } }),
  },
  chat: {
    postMessage: async (args: { channel: string; text: string }) => {
      dms.push(args);
      return { ts: "1.1" };
    },
    update: async () => ({}),
  },
  users: { info: async () => ({ user: { real_name: "Test Person" } }) },
  conversations: { open: async () => ({ channel: { id: "D1" } }) },
};

let repository: InMemoryVolunteerRepository;
let volunteers: VolunteerService;
let submissionId = "";

const text = (value: unknown) => JSON.stringify(value);
const lastView = () => updates.at(-1)?.view;
const blocksOf = (view: Update["view"] | undefined) => (view?.blocks ?? []) as Array<{ type: string; elements?: Array<{ action_id?: string; value?: string }>; accessory?: { action_id?: string; value?: string } }>;

async function press(actionId: string, userId: string, value?: string, view: Record<string, unknown> = { id: "V9", hash: "h", blocks: [], private_metadata: "{}", state: { values: {} } }, extra: Record<string, unknown> = {}): Promise<void> {
  const entry = handlers.actions.find((candidate) =>
    typeof candidate.matcher === "string" ? candidate.matcher === actionId : candidate.matcher.test(actionId),
  );

  assert.ok(entry, `no handler is registered for ${actionId}`);
  await entry.handler({
    ack: async () => undefined,
    action: { action_id: actionId, ...(value ? { value } : {}), ...extra },
    body: { user: { id: userId }, view },
    client,
  });
}

interface SubmitResult {
  acked: { response_action?: string; view?: Update["view"]; errors?: Record<string, string> };
  /** The screen the window ends on once the work has finished. */
  final: Update["view"] | undefined;
}

let submitCounter = 0;

/** Submits the hours form the way Slack does, then waits for the saved result. */
async function submitHours(options: {
  userId: string;
  metadata?: Record<string, unknown>;
  blocks?: unknown[];
  values?: Record<string, unknown>;
  delete?: boolean;
}): Promise<SubmitResult> {
  const result: SubmitResult = { acked: {}, final: undefined };
  const before = updates.length;
  const values: Record<string, unknown> = options.values ?? {
    [blockIds.category]: { category: { selected_option: { value: GENERAL.id } } },
    [blockIds.description]: { description: { value: "Packed food boxes" } },
    [blockIds.date(0)]: { date: { selected_date: "2026-11-10" } },
    [blockIds.hours(0)]: { hours: { value: "3" } },
  };

  if (options.delete) {
    values[blockIds.deleteRequest] = { delete: { selected_options: [{ value: "delete" }] } };
  }

  await handlers.views.get(callbackIds.hoursForm)?.({
    ack: async (response?: SubmitResult["acked"]) => {
      result.acked = response ?? {};
    },
    body: { user: { id: options.userId } },
    client,
    view: {
      id: `VSUBMIT${(submitCounter += 1)}`,
      private_metadata: JSON.stringify({ rowCount: 1, ...options.metadata }),
      blocks: options.blocks ?? [],
      state: { values },
    },
  });
  result.final = updates.length > before ? updates.at(-1)?.view : undefined;

  return result;
}

const buttonsOf = (view: Update["view"] | undefined) =>
  blocksOf(view).flatMap((block) => block.elements ?? []).map((element) => `${element.action_id}:${element.value}`);

describe("the app's buttons and forms, wired together", () => {
  before(async () => {
    for (const kind of patched) {
      originals.set(kind, (App.prototype as never)[kind]);
    }
    (App.prototype as never as Record<string, unknown>).command = (id: string, handler: Handler) => handlers.commands.set(id, handler);
    (App.prototype as never as Record<string, unknown>).action = (id: string | RegExp, handler: Handler) => handlers.actions.push({ matcher: id, handler });
    (App.prototype as never as Record<string, unknown>).view = (id: string, handler: Handler) => handlers.views.set(id, handler);
    (App.prototype as never as Record<string, unknown>).options = (id: string, handler: Handler) => handlers.options.set(id, handler);

    process.env.SLACK_VOLUNTEER_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_VOLUNTEER_APPROVALS_CHANNEL_ID = "C0000000001";

    repository = new InMemoryVolunteerRepository({
      years: [YEAR],
      categories: [GENERAL],
      staff: [
        { slackUserId: ADMIN, displayName: "Admin", title: "Director", canApprove: true, canManage: true, isPrimary: true },
        { slackUserId: APPROVER, displayName: "Approver", title: null, canApprove: true, canManage: false, isPrimary: false },
        { slackUserId: MANAGER, displayName: "Manager", title: null, canApprove: false, canManage: true, isPrimary: false },
      ],
    });
    const adminIds = new Set([ADMIN]);

    volunteers = new VolunteerService(repository, adminIds);
    const services: VolunteerServices = {
      volunteer: volunteers,
      reports: new VolunteerReportService(repository, { organizationName: "UTSC MSA", contactLine: null, logo: null }, adminIds),
      admin: new VolunteerAdminService(repository, adminIds, () => volunteers.invalidateFormData()),
    };

    createVolunteerSlackApp(services, {
      receiver: { init() {}, start: async () => undefined, stop: async () => undefined } as never,
    });

    const saved = await volunteers.saveProfile(VOLUNTEER, {
      studentType: "uoft", firstName: "Jane", lastName: "Doe", preferredEmail: "jane@gmail.com",
      email: "jane@mail.utoronto.ca", utorid: "janedoe", studentNumber: "1000000001",
    });
    assert.equal(saved.ok, true);
    const prepared = await volunteers.prepareSubmission({
      slackSubmissionId: "V1", volunteerSlackUserId: VOLUNTEER, categoryId: GENERAL.id, eventId: null,
      description: "Helped set up", entries: [{ entryDate: "2026-11-12", hours: 2 }],
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) throw new Error("setup failed");
    submissionId = (await volunteers.createSubmission(prepared.prepared)).submission.id;
  });

  after(() => {
    for (const kind of patched) {
      (App.prototype as never as Record<string, unknown>)[kind] = originals.get(kind);
    }
  });

  it("registers the three commands and the Back/Edit buttons", () => {
    assert.deepEqual([...handlers.commands.keys()].sort(), ["/volunteer", "/volunteer-admin", "/volunteer-exec"]);
    assert.ok(handlers.actions.some((entry) => entry.matcher === actionIds.editRequest));
    assert.ok(handlers.actions.some((entry) => entry.matcher instanceof RegExp && entry.matcher.test(hubActionIds.back)));
  });

  it("My hours shows each request as a card with an Edit button, and a Back button", async () => {
    await press(hubActionIds.myHours, VOLUNTEER, "member");

    const view = lastView();

    assert.equal(view?.title?.text, "My hours");
    assert.ok(text(view).includes("Helped set up"));
    assert.ok(text(view).includes("Nov 12, 2026"));
    const first = blocksOf(view)[0];

    assert.equal(first?.elements?.[0]?.action_id, hubActionIds.back);
    assert.equal(first?.elements?.[0]?.value, "member");
    const edit = blocksOf(view).find((block) => block.accessory?.action_id === actionIds.editRequest);

    assert.equal(edit?.accessory?.value, `${submissionId}|my`);
  });

  it("Edit opens the form on the same screen, with Back leading to My hours, and Back survives adding a date", async () => {
    await press(actionIds.editRequest, VOLUNTEER, `${submissionId}|my`);

    const form = lastView();

    assert.equal(form?.callback_id, callbackIds.hoursForm);
    assert.equal(blocksOf(form)[0]?.elements?.[0]?.action_id, hubActionIds.back);
    assert.equal(blocksOf(form)[0]?.elements?.[0]?.value, "my");

    await press(actionIds.addDate, VOLUNTEER, undefined, {
      id: "V9",
      hash: "h",
      blocks: form?.blocks,
      private_metadata: form?.private_metadata,
      state: { values: {} },
    });
    const grown = lastView();

    assert.equal(blocksOf(grown)[0]?.elements?.[0]?.value, "my");
    assert.ok((grown?.blocks?.length ?? 0) > (form?.blocks?.length ?? 0));
  });

  it("Back from My hours returns to the home screen", async () => {
    await press(hubActionIds.back, VOLUNTEER, "member");

    assert.ok(text(lastView()).includes(hubActionIds.hours));
  });

  it("someone else can't open another volunteer's request, and can still go back", async () => {
    await press(actionIds.editRequest, OTHER, `${submissionId}|my`);

    assert.ok(text(lastView()).includes("You can only change your own requests."));
    assert.equal(blocksOf(lastView())[0]?.elements?.[0]?.action_id, hubActionIds.back);
  });

  it("an admin finds a volunteer and sees the same cards, with Back and Edit that return to that list", async () => {
    await press(hubActionIds.records, ADMIN, "admin");
    assert.equal(blocksOf(lastView())[0]?.elements?.[0]?.value, "admin");
    assert.equal(lastView()?.callback_id, callbackIds.recordsPick);

    let acked: { view?: Update["view"] } = {};

    await handlers.views.get(callbackIds.recordsPick)?.({
      ack: async (response?: { view?: Update["view"] }) => {
        acked = response ?? {};
      },
      body: { user: { id: ADMIN } },
      client,
      view: {
        id: "V9",
        state: { values: { [blockIds.recordsVolunteer]: { [actionIds.searchVolunteer]: { selected_option: { value: VOLUNTEER } } } } },
      },
    });

    assert.equal(acked.view?.title?.text, "Volunteer requests");
    assert.ok(text(acked.view).includes("Jane Doe"));
    assert.equal(blocksOf(acked.view)[0]?.elements?.[0]?.value, "admin");
    const edit = blocksOf(acked.view).find((block) => block.accessory?.action_id === actionIds.editRequest);

    assert.equal(edit?.accessory?.value, `${submissionId}|records:${VOLUNTEER}`);

    await press(actionIds.editRequest, ADMIN, edit?.accessory?.value);
    assert.equal(blocksOf(lastView())[0]?.elements?.[0]?.value, `records:${VOLUNTEER}`);

    await press(hubActionIds.back, ADMIN, `records:${VOLUNTEER}`);
    assert.equal(lastView()?.title?.text, "Volunteer requests");
    assert.ok(text(lastView()).includes("Helped set up"));
  });

  it("a member can't use the admin lookup", async () => {
    await press(hubActionIds.records, OTHER, "admin");

    assert.ok(text(lastView()).includes("Only volunteer admins"));
  });

  it("logging hours for someone: search, pick, and you're straight on to their hours form", async () => {
    await press(hubActionIds.hoursFor, ADMIN, "admin");
    const picker = lastView();

    assert.equal(blocksOf(picker)[0]?.elements?.[0]?.value, "admin");
    assert.ok(text(picker).includes(actionIds.behalfFind));
    assert.ok(text(picker).includes(actionIds.behalfNew));
    assert.equal(picker?.callback_id, undefined, "no Next button: picking moves on by itself");

    await press(actionIds.behalfFind, ADMIN, undefined, undefined, { selected_option: { value: VOLUNTEER } });
    const form = lastView();

    assert.equal(form?.callback_id, callbackIds.hoursForm);
    assert.ok(text(form).includes("Jane Doe"));
    assert.equal(blocksOf(form)[0]?.elements?.[0]?.value, "behalf");

    await press(hubActionIds.back, ADMIN, "behalf");
    assert.ok(text(lastView()).includes(actionIds.behalfFind), "Back returns to the picker");
  });

  it("logging hours for someone new starts with their details", async () => {
    await press(actionIds.behalfNew, ADMIN);

    assert.equal(lastView()?.callback_id, callbackIds.profileType);
    assert.equal(blocksOf(lastView())[0]?.elements?.[0]?.value, "behalf");
  });

  it("picking someone without a profile says so instead of opening a form", async () => {
    await press(actionIds.behalfFind, ADMIN, undefined, undefined, { selected_option: { value: "UNOPROFILE1" } });

    assert.ok(text(lastView()).includes("profile no longer exists"));
  });

  it("only admins can use the volunteer search or the picker buttons", async () => {
    await press(actionIds.behalfFind, OTHER, undefined, undefined, { selected_option: { value: VOLUNTEER } });
    assert.ok(text(lastView()).includes("Only volunteer admins"));
    await press(actionIds.behalfNew, OTHER);
    assert.ok(text(lastView()).includes("Only volunteer admins"));

    const answer = async (user: string) => {
      let options: unknown[] = [];

      await handlers.options.get(actionIds.behalfFind)?.({
        ack: async (response: { options: unknown[] }) => {
          options = response.options;
        },
        body: { user: { id: user } },
        options: { value: "jane" },
      });

      return options;
    };

    assert.equal((await answer(ADMIN)).length, 1);
    assert.deepEqual(await answer(OTHER), []);
  });

  it("submitting hours shows Saving…, then a confirmation with what to do next, and posts the approval card", async () => {
    dms.length = 0;
    const posts = dms.length;
    const result = await submitHours({ userId: VOLUNTEER });

    assert.equal(result.acked.response_action, "update");
    assert.ok(text(result.acked.view).includes("Saving…"), "the window stays open on a Saving screen");
    assert.ok(text(result.final).includes("Got it!"), "then becomes the confirmation");
    assert.ok(text(result.final).includes("3 h"));
    assert.deepEqual(buttonsOf(result.final), [`${hubActionIds.hours}:member`, `${hubActionIds.myHours}:member`]);
    assert.ok(dms.some((message) => message.channel === "C0000000001"), "the approval card is posted");
    assert.ok(!dms.some((message) => message.channel === VOLUNTEER), "no duplicate DM when the screen was shown");
    assert.equal(posts, 0);
  });

  it("if the window was closed meanwhile, the confirmation arrives as a DM instead", async () => {
    dms.length = 0;
    const original = client.views.update;

    client.views.update = async () => {
      throw new Error("not_found");
    };

    try {
      await submitHours({
        userId: VOLUNTEER,
        values: {
          [blockIds.category]: { category: { selected_option: { value: GENERAL.id } } },
          [blockIds.description]: { description: { value: "Cleanup" } },
          [blockIds.date(0)]: { date: { selected_date: "2026-11-09" } },
          [blockIds.hours(0)]: { hours: { value: "1" } },
        },
      });
    } finally {
      client.views.update = original;
    }

    assert.ok(dms.some((message) => message.channel === VOLUNTEER && message.text.includes("Got it!")));
  });

  it("a mistake is shown inline on the form, and nothing is saved", async () => {
    const result = await submitHours({
      userId: VOLUNTEER,
      values: {
        [blockIds.description]: { description: { value: "" } },
        [blockIds.date(0)]: { date: { selected_date: null } },
        [blockIds.hours(0)]: { hours: { value: "" } },
      },
    });

    assert.ok(result.acked.errors && Object.keys(result.acked.errors).length > 0);
    assert.equal(result.final, undefined);
  });

  it("an admin logging for someone gets a confirmation offering to log for someone else", async () => {
    const result = await submitHours({
      userId: ADMIN,
      metadata: { forUserId: VOLUNTEER, forName: "Jane Doe" },
      values: {
        [blockIds.category]: { category: { selected_option: { value: GENERAL.id } } },
        [blockIds.description]: { description: { value: "Door shift" } },
        [blockIds.date(0)]: { date: { selected_date: "2026-11-08" } },
        [blockIds.hours(0)]: { hours: { value: "2" } },
      },
    });

    assert.ok(text(result.final).includes("approved"));
    assert.deepEqual(buttonsOf(result.final), [`${hubActionIds.hoursFor}:admin`, `${hubActionIds.back}:admin`]);
  });

  it("editing a request ends on a confirmation that leads back to My hours", async () => {
    const result = await submitHours({
      userId: VOLUNTEER,
      metadata: { editSubmissionId: submissionId, editAsExec: false },
      blocks: [{ type: "actions", elements: [{ action_id: hubActionIds.back, value: "my" }] }],
      values: {
        [blockIds.category]: { category: { selected_option: { value: GENERAL.id } } },
        [blockIds.description]: { description: { value: "Helped set up (corrected)" } },
        [blockIds.date(0)]: { date: { selected_date: "2026-11-12" } },
        [blockIds.hours(0)]: { hours: { value: "4" } },
      },
    });

    assert.ok(text(result.acked.view).includes("Saving…"));
    assert.ok(text(result.final).includes("back to the approvers") || text(result.final).includes("saved") || text(result.final).includes("Saved"));
    assert.deepEqual(buttonsOf(result.final), [`${hubActionIds.back}:my`]);
  });

  it("an admin's edit leads back to that volunteer's requests, and a no-change save says so", async () => {
    const origin = `records:${VOLUNTEER}`;
    const same = {
      [blockIds.category]: { category: { selected_option: { value: GENERAL.id } } },
      [blockIds.description]: { description: { value: "Helped set up (corrected)" } },
      [blockIds.date(0)]: { date: { selected_date: "2026-11-12" } },
      [blockIds.hours(0)]: { hours: { value: "4" } },
    };
    const result = await submitHours({
      userId: ADMIN,
      metadata: { forUserId: VOLUNTEER, forName: "Jane Doe", editSubmissionId: submissionId, editAsExec: true },
      blocks: [{ type: "actions", elements: [{ action_id: hubActionIds.back, value: origin }] }],
      values: same,
    });

    assert.ok(text(result.final).includes("Nothing was different"));
    // Two Back buttons in one row: Slack needs different action ids, so the
    // second one carries a ":2" suffix (its value still says where it leads).
    assert.deepEqual(buttonsOf(result.final), [`${hubActionIds.back}:${origin}`, `${hubActionIds.back}:2:admin`]);

    // ...and the suffixed button still works: it goes to the admin home.
    await press(`${hubActionIds.back}:2`, ADMIN, "admin");
    assert.equal(lastView()?.title?.text, "Volunteer admin");
  });

  it("deleting a request ends on a confirmation too", async () => {
    const result = await submitHours({
      userId: ADMIN,
      metadata: { forUserId: VOLUNTEER, forName: "Jane Doe", editSubmissionId: submissionId, editAsExec: true },
      blocks: [{ type: "actions", elements: [{ action_id: hubActionIds.back, value: `records:${VOLUNTEER}` }] }],
      values: {},
      delete: true,
    });

    assert.ok(text(result.acked.view).includes("Deleting…"));
    assert.ok(text(result.final).includes("Deleted the request"));
    assert.equal(await repository.getSubmission(submissionId), null);
  });

  describe("the approvers' queue", () => {
    const queueView = (home: string, extraBlocks: unknown[] = []) => ({
      id: "VQUEUE",
      hash: "h",
      blocks: [{ type: "actions", elements: [{ action_id: hubActionIds.back, value: home }] }, ...extraBlocks],
      private_metadata: "{}",
      state: { values: {} },
    });
    const approveValue = async () => {
      const queue = await volunteers.getPendingQueue(APPROVER);
      const request = queue?.requests.find((candidate) => candidate.description === "Queue test");

      assert.ok(request, "the queue test request should be pending");

      return `${request.id}:${request.version}`;
    };

    before(async () => {
      const prepared = await volunteers.prepareSubmission({
        slackSubmissionId: "VQUEUE1", volunteerSlackUserId: VOLUNTEER, categoryId: GENERAL.id, eventId: null,
        description: "Queue test", entries: [{ entryDate: "2026-11-05", hours: 3 }],
      });
      if (!prepared.ok) throw new Error("setup failed");
      await volunteers.createSubmission(prepared.prepared);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await volunteers.prepareSubmission({
        slackSubmissionId: "VQUEUE2", volunteerSlackUserId: VOLUNTEER, categoryId: GENERAL.id, eventId: null,
        description: "Queue second", entries: [{ entryDate: "2026-11-04", hours: 1 }],
      });
      if (!second.ok) throw new Error("setup failed");
      await volunteers.createSubmission(second.prepared);
    });

    it("the exec home says how many are waiting", async () => {
      let opened: Update["view"] | undefined;
      const original = client.views.update;

      await handlers.commands.get("/volunteer-exec")?.({
        ack: async () => undefined,
        command: { trigger_id: "T1", user_id: APPROVER },
        client: { ...client, views: { ...client.views, update: async (args: { view: Update["view"] }) => { opened = args.view; return {}; } } },
        respond: async () => undefined,
      });
      client.views.update = original;

      assert.ok(text(opened).includes("Pending requests ("), text(opened));
    });

    it("opens the queue with the longest-waiting request first and Approve / Disapprove buttons", async () => {
      await press(hubActionIds.pending, APPROVER, "exec");
      const view = lastView();

      assert.equal(view?.title?.text, "Pending requests");
      assert.equal(blocksOf(view)[0]?.elements?.[0]?.value, "exec");
      assert.ok(text(view).indexOf("Queue test") < text(view).indexOf("Queue second"), "submitted first, shown first");
      assert.ok(text(view).includes(actionIds.approve) && text(view).includes(actionIds.disapprove));
    });

    it("a manager (who can't approve) sees the queue without buttons", async () => {
      await press(hubActionIds.pending, MANAGER, "exec");

      assert.ok(text(lastView()).includes("Queue test"));
      assert.ok(!text(lastView()).includes(actionIds.approve));
      assert.ok(text(lastView()).includes("only Execs can approve or disapprove"));
    });

    it("someone who isn't an exec can't open it", async () => {
      await press(hubActionIds.pending, OTHER, "exec");

      assert.ok(text(lastView()).includes("Only volunteer execs and admins"));
    });

    it("Approve decides the request, tells the volunteer, and redraws the queue without it", async () => {
      dms.length = 0;
      const value = await approveValue();

      await press(actionIds.approve, APPROVER, value, queueView("exec"));
      const view = lastView();
      const after = await volunteers.getPendingQueue(APPROVER);

      assert.ok(text(view).includes("✅ Approved Jane Doe's 3 h."));
      assert.ok(!text(view).includes("Queue test"));
      assert.equal(blocksOf(view)[0]?.elements?.[0]?.value, "exec");
      assert.ok(!after?.requests.some((request) => request.description === "Queue test"));
      assert.ok(dms.some((message) => message.channel === VOLUNTEER && message.text.includes("approved")));
      assert.ok(!dms.some((message) => message.channel === APPROVER), "no extra DM for the approver; the queue says it");
    });

    it("clicking Approve on a request someone else already decided says so", async () => {
      const queue = await volunteers.getPendingQueue(APPROVER);
      const request = queue?.requests[0];

      assert.ok(request);
      const value = `${request.id}:${request.version}`;
      await volunteers.decide({ submissionId: request.id, decidedBySlackUserId: ADMIN, decision: "approved", note: null });

      await press(actionIds.approve, APPROVER, value, queueView("admin"));

      assert.ok(text(lastView()).includes("⚠️ That request was already approved"));
      assert.equal(blocksOf(lastView())[0]?.elements?.[0]?.value, "admin", "stays on the home it came from");
    });

    it("a manager who can't approve is refused even if they press an old button", async () => {
      await volunteers.prepareSubmission({
        slackSubmissionId: "VQUEUE3", volunteerSlackUserId: VOLUNTEER, categoryId: GENERAL.id, eventId: null,
        description: "Refusal test", entries: [{ entryDate: "2026-11-03", hours: 1 }],
      }).then((prepared) => (prepared.ok ? volunteers.createSubmission(prepared.prepared) : null));
      const queue = await volunteers.getPendingQueue(APPROVER);
      const request = queue?.requests.find((candidate) => candidate.description === "Refusal test");

      assert.ok(request);
      await press(actionIds.approve, MANAGER, `${request.id}:${request.version}`, queueView("exec"));

      assert.ok(text(lastView()).includes("⚠️ You don't have permission to approve volunteer hours."));
      assert.equal((await repository.getSubmission(request.id))?.status, "pending");
    });

    it("Disapprove opens the reason form in place, with Back to the queue; submitting it disapproves and returns", async () => {
      const queue = await volunteers.getPendingQueue(APPROVER);
      const request = queue?.requests.find((candidate) => candidate.description === "Refusal test");

      assert.ok(request);
      const value = `${request.id}:${request.version}`;

      await press(actionIds.disapprove, APPROVER, value, queueView("admin"));
      const form = lastView();

      assert.equal(form?.callback_id, callbackIds.rejectReason);
      assert.equal(blocksOf(form)[0]?.elements?.[0]?.value, "pending:admin");

      let acked: { view?: Update["view"]; errors?: Record<string, string> } = {};
      const submit = (reason: string) =>
        handlers.views.get(callbackIds.rejectReason)?.({
          ack: async (response?: typeof acked) => {
            acked = response ?? {};
          },
          body: { user: { id: APPROVER } },
          client,
          view: { id: "VREASON", private_metadata: form?.private_metadata, state: { values: { [blockIds.reason]: { reason: { value: reason } } } } },
        });

      await submit("   ");
      assert.ok(acked.errors && blockIds.reason in acked.errors, "a reason is required");

      dms.length = 0;
      await submit("Wrong date");
      assert.ok(text(acked.view).includes("Saving…"));
      assert.ok(text(lastView()).includes("Disapproved Jane Doe's 1 h."));
      assert.equal(blocksOf(lastView())[0]?.elements?.[0]?.value, "admin");
      const decided = await repository.getSubmission(request.id);

      assert.deepEqual([decided?.status, decided?.decisionNote], ["rejected", "Wrong date"]);
      assert.ok(dms.some((message) => message.channel === VOLUNTEER && message.text.includes("Wrong date")));
    });
  });

  describe("deciding from a volunteer's request list (admin: Find a volunteer's requests)", () => {
    const listView = (value = "admin") => ({
      id: "VREC",
      hash: "h",
      blocks: [{ type: "actions", elements: [{ action_id: hubActionIds.back, value }] }],
      private_metadata: "{}",
      state: { values: {} },
    });
    const addPending = async (slackSubmissionId: string, description: string, date: string, hours: number) => {
      const prepared = await volunteers.prepareSubmission({
        slackSubmissionId, volunteerSlackUserId: VOLUNTEER, categoryId: GENERAL.id, eventId: null,
        description, entries: [{ entryDate: date, hours }],
      });
      if (!prepared.ok) throw new Error("setup failed");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return (await volunteers.createSubmission(prepared.prepared)).submission;
    };
    const openList = async (userId: string) => {
      await press(hubActionIds.back, userId, `records:${VOLUNTEER}`);

      return lastView();
    };
    const decisionButtons = (view: Update["view"] | undefined) =>
      blocksOf(view).flatMap((block) => block.elements ?? []).filter((element) => element.action_id === actionIds.approve || element.action_id === actionIds.disapprove);
    const valueOf = (id: string, version = 0) => `${id}:${version}|records:${VOLUNTEER}`;
    let first: { id: string; version: number };
    let second: { id: string; version: number };
    let third: { id: string; version: number };

    before(async () => {
      first = await addPending("VREC1", "Records approve me", "2026-11-06", 4);
      second = await addPending("VREC2", "Records disapprove me", "2026-11-07", 1.5);
      third = await addPending("VREC3", "Records refusal test", "2026-11-08", 2);
    });

    it("an approver sees Approve and Disapprove under each pending request, and the Edit buttons stay", async () => {
      const view = await openList(ADMIN);
      const pendingNow = (await repository.listSubmissionsForVolunteer(VOLUNTEER, 100)).filter((request) => request.status === "pending");

      assert.equal(view?.title?.text, "Volunteer requests");
      assert.equal(decisionButtons(view).filter((button) => button.action_id === actionIds.approve).length, pendingNow.length);
      assert.equal(decisionButtons(view).filter((button) => button.action_id === actionIds.disapprove).length, pendingNow.length);
      assert.ok(decisionButtons(view).some((button) => button.value === valueOf(first.id, first.version)));
      assert.ok(blocksOf(view).some((block) => block.accessory?.action_id === actionIds.editRequest));
      assert.equal(blocksOf(view)[0]?.elements?.[0]?.value, "admin");
    });

    it("an exec who can look but not approve sees the same list with no decision buttons", async () => {
      const view = await openList(MANAGER);

      assert.ok(text(view).includes("Records approve me"));
      assert.deepEqual(decisionButtons(view), []);
    });

    it("Approve decides it, tells the volunteer, and redraws the same list with a confirmation", async () => {
      dms.length = 0;
      await press(actionIds.approve, ADMIN, valueOf(first.id, first.version), listView());
      const view = lastView();
      const decided = await repository.getSubmission(first.id);

      assert.equal(decided?.status, "approved");
      assert.equal(decided?.decidedBySlackUserId, ADMIN);
      assert.equal(view?.title?.text, "Volunteer requests");
      assert.ok(text(view).includes("✅ Approved Jane Doe's 4 h."));
      assert.ok(!decisionButtons(view).some((button) => button.value === valueOf(first.id, first.version)), "its buttons are gone");
      assert.ok(decisionButtons(view).some((button) => button.value === valueOf(second.id, second.version)), "the others keep theirs");
      assert.equal(blocksOf(view)[0]?.elements?.[0]?.value, "admin", "Back still leads to the admin home");
      assert.ok(dms.some((message) => message.channel === VOLUNTEER && message.text.includes("approved")));
      assert.ok(!dms.some((message) => message.channel === ADMIN), "no extra DM for the approver; the list says it");
    });

    it("Disapprove replaces the list with a reason form that has Back; Back returns to the list", async () => {
      await press(actionIds.disapprove, ADMIN, valueOf(second.id, second.version), listView());
      const form = lastView();

      assert.equal(form?.callback_id, callbackIds.rejectReason);
      assert.equal(blocksOf(form)[0]?.elements?.[0]?.value, `records:${VOLUNTEER}`);
      assert.deepEqual(JSON.parse(form?.private_metadata ?? "{}"), { submissionId: second.id, version: second.version, returnTo: `records:${VOLUNTEER}` });
      assert.equal((await repository.getSubmission(second.id))?.status, "pending", "nothing is decided until a reason is submitted");

      await press(hubActionIds.back, ADMIN, `records:${VOLUNTEER}`);

      assert.equal(lastView()?.title?.text, "Volunteer requests");
    });

    it("a reason is required, then it disapproves, tells the volunteer why, and returns to the list", async () => {
      await press(actionIds.disapprove, ADMIN, valueOf(second.id, second.version), listView());
      const form = lastView();
      let acked: { view?: Update["view"]; errors?: Record<string, string> } = {};
      const submit = (reason: string) =>
        handlers.views.get(callbackIds.rejectReason)?.({
          ack: async (response?: typeof acked) => {
            acked = response ?? {};
          },
          body: { user: { id: ADMIN } },
          client,
          view: { id: "VREASON2", private_metadata: form?.private_metadata, state: { values: { [blockIds.reason]: { reason: { value: reason } } } } },
        });

      await submit("   ");
      assert.ok(acked.errors && blockIds.reason in acked.errors);
      assert.equal((await repository.getSubmission(second.id))?.status, "pending");

      dms.length = 0;
      await submit("Wrong date, please fix");
      const decided = await repository.getSubmission(second.id);

      assert.ok(text(acked.view).includes("Saving…"));
      assert.deepEqual([decided?.status, decided?.decisionNote, decided?.decidedBySlackUserId], ["rejected", "Wrong date, please fix", ADMIN]);
      assert.equal(lastView()?.title?.text, "Volunteer requests");
      assert.ok(text(lastView()).includes("Disapproved Jane Doe's 1.5 h."));
      assert.ok(text(lastView()).includes("Wrong date, please fix"), "the card now shows the reason");
      assert.equal(blocksOf(lastView())[0]?.elements?.[0]?.value, "admin");
      assert.ok(dms.some((message) => message.channel === VOLUNTEER && message.text.includes("Wrong date, please fix")));
    });

    it("someone without the approve permission is refused even with a valid button, and nothing changes", async () => {
      await press(actionIds.approve, MANAGER, valueOf(third.id, third.version), listView());

      assert.ok(text(lastView()).includes("⚠️ You don't have permission to approve volunteer hours."));
      assert.equal((await repository.getSubmission(third.id))?.status, "pending");

      await press(actionIds.disapprove, MANAGER, valueOf(third.id, third.version), listView());
      const form = lastView();
      await handlers.views.get(callbackIds.rejectReason)?.({
        ack: async () => undefined,
        body: { user: { id: MANAGER } },
        client,
        view: { id: "VREASON3", private_metadata: form?.private_metadata, state: { values: { [blockIds.reason]: { reason: { value: "No" } } } } },
      });

      assert.ok(text(lastView()).includes("⚠️ You don't have permission to approve volunteer hours."));
      assert.equal((await repository.getSubmission(third.id))?.status, "pending");
    });

    it("a button for a request that was edited since it was shown is refused, with the list refreshed", async () => {
      await press(actionIds.approve, ADMIN, valueOf(third.id, third.version + 1), listView());

      assert.ok(text(lastView()).includes("⚠️ That request was just edited"));
      assert.equal((await repository.getSubmission(third.id))?.status, "pending");
    });

    it("a request someone else already decided says so, and shows who", async () => {
      await volunteers.decide({ submissionId: third.id, decidedBySlackUserId: APPROVER, decision: "approved", note: null });
      await press(actionIds.approve, ADMIN, valueOf(third.id, third.version), listView());

      assert.ok(text(lastView()).includes(`⚠️ That request was already approved by <@${APPROVER}>`));
      assert.equal((await repository.getSubmission(third.id))?.decidedBySlackUserId, APPROVER);
      assert.ok(!decisionButtons(lastView()).some((button) => button.value === valueOf(third.id, third.version)));
    });

    it("the volunteer's own My hours screen never has decision buttons", async () => {
      await press(hubActionIds.myHours, VOLUNTEER, "member");

      assert.deepEqual(decisionButtons(lastView()), []);
    });
  });

  it("every first screen of a form opened from a home has a Back button to that home", async () => {
    const cases: Array<[string, string, string]> = [
      [hubActionIds.hours, ADMIN, "member"],
      [hubActionIds.profile, ADMIN, "member"],
      [hubActionIds.myHours, ADMIN, "member"],
      [hubActionIds.report, ADMIN, "exec"],
      [hubActionIds.report, ADMIN, "admin"],
      [hubActionIds.pending, ADMIN, "exec"],
      [hubActionIds.pending, ADMIN, "admin"],
      [hubActionIds.letters, ADMIN, "exec"],
      [hubActionIds.letters, ADMIN, "admin"],
      [hubActionIds.hoursFor, ADMIN, "admin"],
      [hubActionIds.records, ADMIN, "admin"],
    ];

    for (const [actionId, user, home] of cases) {
      await press(actionId, user, home);
      const first = blocksOf(lastView())[0]?.elements?.[0];

      assert.equal(first?.action_id, hubActionIds.back, `${actionId} from ${home}`);
      assert.equal(first?.value, home, `${actionId} from ${home}`);
    }
  });

  it("choosing a category redraws the hours form: the Event dropdown shows only for a category that asks for an event", async () => {
    const special = await repository.createCategory("Specific Event", true);
    await repository.createEvent("Fall Iftar", "2026-11-20");
    volunteers.invalidateFormData();

    try {
      await press(hubActionIds.hours, VOLUNTEER, "member");
      const form = lastView();

      assert.equal(form?.callback_id, callbackIds.hoursForm);
      assert.ok(!text(form).includes(blockIds.event), "no Event dropdown before a category is chosen");

      const state = (categoryId: string) => ({
        [blockIds.category]: { category: { selected_option: { value: categoryId } } },
        [blockIds.description]: { description: { value: "Packed food boxes" } },
        [blockIds.date(0)]: { date: { selected_date: "2026-11-10" } },
        [blockIds.hours(0)]: { hours: { value: "2" } },
      });
      const choose = (categoryId: string) =>
        press(actionIds.category, VOLUNTEER, undefined, {
          id: "V9",
          hash: "h",
          blocks: form?.blocks,
          private_metadata: form?.private_metadata,
          state: { values: state(categoryId) },
        });

      await choose(special.id);
      const withEvent = lastView();

      assert.ok(text(withEvent).includes(blockIds.event), "the Event dropdown appears for Specific Event");
      assert.ok(text(withEvent).includes("Fall Iftar"));
      assert.ok(text(withEvent).includes("Packed food boxes"), "what was typed is kept");
      assert.equal(blocksOf(withEvent)[0]?.elements?.[0]?.action_id, hubActionIds.back, "Back is kept");

      await choose(GENERAL.id);

      assert.ok(!text(lastView()).includes(blockIds.event), "and goes away again for General");
      assert.ok(text(lastView()).includes("Packed food boxes"));
    } finally {
      await repository.updateCategory(special.id, { isActive: false });
      volunteers.invalidateFormData();
    }
  });

  // Keep this last: it checks every screen the tests above made the real
  // handlers produce (confirmation screens included) against Slack's rules, so
  // a screen Slack would refuse can't slip through just because no builder test
  // happens to cover it.
  it("every screen the handlers sent is one Slack would accept", () => {
    assert.ok(everyScreen.length > 30, `only ${everyScreen.length} screens were captured`);

    const problems = everyScreen.flatMap((view, index) =>
      checkView(view as never, `screen ${index}: ${view?.title?.text ?? "?"}`, "modal"),
    );

    assert.deepEqual([...new Set(problems)], []);
  });
});
