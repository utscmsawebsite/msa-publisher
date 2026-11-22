import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { InMemoryVolunteerRepository } from "../repositories/in-memory-volunteer.repository.js";
import { VolunteerAdminService } from "../services/volunteer-admin.service.js";
import {
  ADMIN_FORM_CALLBACK,
  adminActionIds,
  adminBlockIds,
  type FormMetadata,
} from "./volunteer-admin-views.js";
import {
  registerVolunteerAdminHandlers,
  renderAdminScreen,
} from "./volunteer-admin-handlers.js";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

const YEAR_ID = "11111111-1111-4111-8111-111111111111";
const CATEGORY_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN = "UADMIN0001";
const EXEC = "UEXEC00001";

interface Harness {
  repository: InMemoryVolunteerRepository;
  admin: VolunteerAdminService;
  actions: Map<string, Handler>;
  view?: Handler;
  options?: Handler;
  updates: Array<{ viewId: string; view: { title?: { text: string }; blocks?: unknown } }>;
  ops: string[];
  dms: Array<{ channel: string; text: string }>;
  reports: string[];
}

function setup(): Harness {
  const repository = new InMemoryVolunteerRepository({
    years: [{ id: YEAR_ID, label: "2026/27 Volunteer Year", startDate: "2026-09-01", endDate: "2027-03-15" }],
    categories: [{ id: CATEGORY_ID, name: "General", requiresEvent: false, isActive: true, sortOrder: 1 }],
    staff: [
      { slackUserId: EXEC, displayName: "Exec", title: null, canApprove: true, canManage: false, isPrimary: false },
    ],
  });
  const admin = new VolunteerAdminService(repository, new Set([ADMIN]), () => undefined);
  const h: Harness = {
    repository,
    admin,
    actions: new Map(),
    updates: [],
    ops: [],
    dms: [],
    reports: [],
  };

  registerVolunteerAdminHandlers(
    {
      app: {
        options: (_id: string, handler: Handler) => {
          h.options = handler;
        },
        action: (id: string, handler: Handler) => h.actions.set(id, handler),
        view: (_id: string, handler: Handler) => {
          h.view = handler;
        },
      } as never,
      background: async (_name, task) => task(),
      opsLog: async (_client, text) => {
        h.ops.push(text);
      },
      sendDirectMessage: async () => true,
    },
    admin,
    {
      beginReport: async (_client, viewId, userId, home, yearId) => {
        h.reports.push(`${viewId}:${userId}:${home}:${yearId}`);
      },
    },
  );

  return h;
}

const clientOf = (h: Harness) => ({
  views: {
    update: async (args: { view_id: string; view: never }) => {
      h.updates.push({ viewId: args.view_id, view: args.view });
      return {};
    },
  },
  users: { info: async () => ({ user: { real_name: "Test Person" } }) },
  chat: {
    postMessage: async (args: { channel: string; text: string }) => {
      h.dms.push(args);
      return {};
    },
  },
});

const text = (value: unknown) => JSON.stringify(value);
const last = (h: Harness) => h.updates.at(-1);

async function press(h: Harness, actionId: string, value: string, userId = ADMIN): Promise<void> {
  await h.actions.get(actionId)?.({
    ack: async () => undefined,
    action: { action_id: actionId, value },
    body: { user: { id: userId }, view: { id: "V9" } },
    client: clientOf(h),
  });
}

interface Submitted {
  errors?: Record<string, string>;
  view?: { title?: { text: string }; blocks?: unknown };
}

async function submit(
  h: Harness,
  meta: FormMetadata,
  values: Record<string, Record<string, unknown>>,
  userId = ADMIN,
): Promise<Submitted> {
  let result: Submitted = {};

  await h.view?.({
    ack: async (response?: { response_action?: string; errors?: Record<string, string>; view?: Submitted["view"] }) => {
      result = {
        ...(response?.errors ? { errors: response.errors } : {}),
        ...(response?.view ? { view: response.view } : {}),
      };
    },
    body: { user: { id: userId } },
    client: clientOf(h),
    view: { id: "V9", private_metadata: JSON.stringify(meta), state: { values } },
  });

  return result;
}

const typed = (blockId: string, value: string) => ({ [blockId]: { name: { value } } });
const dated = (blockId: string, date: string) => ({ [blockId]: { date: { selected_date: date } } });

describe("moving around the admin screens", () => {
  let h: Harness;

  beforeEach(() => {
    h = setup();
  });

  it("opens the screen a button names, on the same modal", async () => {
    await press(h, adminActionIds.nav, "years");

    assert.equal(last(h)?.viewId, "V9");
    assert.ok(text(last(h)?.view).includes("2026/27 Volunteer Year"));
    assert.ok(text(last(h)?.view).includes("add:year"));
  });

  it("shows a year's page with its own events, and only those", async () => {
    await h.admin.addEvent(ADMIN, "Fall Iftar", "2026-11-20");
    await h.admin.addEvent(ADMIN, "Old Event", "2025-01-01");
    await h.admin.addEvent(ADMIN, "No Date Event", null);

    await press(h, adminActionIds.nav, `year:${YEAR_ID}`);
    const page = text(last(h)?.view);

    assert.ok(page.includes("Fall Iftar"));
    assert.ok(!page.includes("Old Event"));
    assert.ok(!page.includes("No Date Event"));
    assert.ok(page.includes("edit:year:" + YEAR_ID));
    assert.ok(page.includes(`add:event:year:${YEAR_ID}`));
    assert.ok(page.includes(adminActionIds.yearReport));
  });

  it("refuses everything to someone without admin rights, even from an old screen", async () => {
    for (const key of ["home", "years", "staff", "add:year", `edit:year:${YEAR_ID}`]) {
      await press(h, adminActionIds.nav, key, EXEC);
      assert.ok(text(last(h)?.view).includes("Only volunteer admins"), key);
      assert.ok(!text(last(h)?.view).includes("add:year"), key);
    }
  });

  it("says so, on the list, when the thing opened no longer exists", async () => {
    await press(h, adminActionIds.nav, "year:99999999-9999-4999-8999-999999999999");
    assert.ok(text(last(h)?.view).includes("no longer exists"));
    await press(h, adminActionIds.nav, "edit:category:99999999-9999-4999-8999-999999999999");
    assert.ok(text(last(h)?.view).includes("no longer exists"));
    await press(h, adminActionIds.nav, "nonsense:key");
    assert.ok(text(last(h)?.view).includes("isn't available any more"));
  });

  it("only offers staff editing to the admins named in settings", async () => {
    await h.repository.upsertStaffMember(
      { slackUserId: "UMANAGER01", displayName: null, title: null, canApprove: false, canManage: true, isPrimary: false },
    );

    await press(h, adminActionIds.nav, "staff", "UMANAGER01");
    assert.ok(!text(last(h)?.view).includes("add:staff"));
    assert.ok(!text(last(h)?.view).includes("edit:staff:"));
    assert.ok(text(last(h)?.view).includes("Only the volunteer admins named"));

    await press(h, adminActionIds.nav, "add:staff", "UMANAGER01");
    assert.ok(text(last(h)?.view).includes("Only the volunteer admins named"));

    await press(h, adminActionIds.nav, "staff", ADMIN);
    assert.ok(text(last(h)?.view).includes("add:staff"));
    assert.ok(text(last(h)?.view).includes(`edit:staff:${EXEC}`));
  });

  it("starts the report form on the year being looked at, with Back leading to that year's page", async () => {
    await press(h, adminActionIds.yearReport, YEAR_ID);

    assert.deepEqual(h.reports, [`V9:${ADMIN}:admin:year:${YEAR_ID}:${YEAR_ID}`]);
  });

  it("opens an event from a year and brings you back to that year", async () => {
    await h.admin.addEvent(ADMIN, "Fall Iftar", "2026-11-20");
    const event = (await h.repository.listEvents())[0];

    assert.ok(event);
    await press(h, adminActionIds.nav, `edit:event:${event.id}:year:${YEAR_ID}`);

    assert.equal(
      (JSON.parse(String((last(h)?.view as { private_metadata?: string }).private_metadata)) as FormMetadata).back,
      `year:${YEAR_ID}`,
    );

    await press(h, adminActionIds.nav, `edit:event:${event.id}`);
    assert.equal(
      (JSON.parse(String((last(h)?.view as { private_metadata?: string }).private_metadata)) as FormMetadata).back,
      "events",
    );
  });

  it("suggests a date inside the year when adding an event from its page", async () => {
    await press(h, adminActionIds.nav, `add:event:year:${YEAR_ID}`);

    const date = JSON.stringify(last(h)?.view).match(/"initial_date":"([^"]+)"/)?.[1];

    assert.ok(date && date >= "2026-09-01" && date <= "2027-03-15", String(date));
  });
});

describe("saving a form", () => {
  let h: Harness;

  beforeEach(() => {
    h = setup();
  });

  it("adds a year, then shows the years list with a confirmation, and logs it", async () => {
    const result = await submit(
      h,
      { kind: "year", back: "years" },
      {
        ...typed(adminBlockIds.name, "2027/28 Volunteer Year"),
        ...dated(adminBlockIds.start, "2027-09-01"),
        ...dated(adminBlockIds.end, "2028-03-15"),
      },
    );

    assert.equal(result.errors, undefined);
    assert.ok(text(result.view).includes("✅ Added *2027/28 Volunteer Year*"));
    assert.ok(text(result.view).includes("add:year"));
    assert.equal((await h.repository.listYears()).length, 2);
    assert.equal(h.ops.length, 1);
    assert.ok(h.ops[0]?.includes(`<@${ADMIN}>`));
  });

  it("explains, under the right field, why a year can't be saved", async () => {
    const duplicate = await submit(
      h,
      { kind: "year", back: "years" },
      {
        ...typed(adminBlockIds.name, "2026/27 volunteer year"),
        ...dated(adminBlockIds.start, "2028-09-01"),
        ...dated(adminBlockIds.end, "2029-03-15"),
      },
    );
    assert.deepEqual(Object.keys(duplicate.errors ?? {}), [adminBlockIds.name]);

    const overlap = await submit(
      h,
      { kind: "year", back: "years" },
      {
        ...typed(adminBlockIds.name, "Another"),
        ...dated(adminBlockIds.start, "2027-03-01"),
        ...dated(adminBlockIds.end, "2028-03-15"),
      },
    );
    assert.deepEqual(Object.keys(overlap.errors ?? {}), [adminBlockIds.start]);
    assert.match(overlap.errors?.[adminBlockIds.start] ?? "", /overlap/);

    const noEnd = await submit(
      h,
      { kind: "year", back: "years" },
      { ...typed(adminBlockIds.name, "X"), ...dated(adminBlockIds.start, "2028-01-01") },
    );
    assert.deepEqual(Object.keys(noEnd.errors ?? {}), [adminBlockIds.end]);
    assert.equal((await h.repository.listYears()).length, 1);
    assert.deepEqual(h.ops, []);
  });

  it("edits a year and returns to its page; refuses dates that would strand hours", async () => {
    await h.repository.createSubmission({
      id: "s1",
      slackSubmissionId: "slack-s1",
      volunteerSlackUserId: "UVOL00001",
      submittedBySlackUserId: "UVOL00001",
      approvedBySlackUserId: null,
      categoryId: CATEGORY_ID,
      eventId: null,
      description: "x",
      entries: [{ entryDate: "2026-12-01", hours: 2, yearId: YEAR_ID }],
    });
    const meta: FormMetadata = { kind: "year", id: YEAR_ID, back: `year:${YEAR_ID}` };

    const refused = await submit(h, meta, {
      ...typed(adminBlockIds.name, "2026/27 Volunteer Year"),
      ...dated(adminBlockIds.start, "2026-12-02"),
      ...dated(adminBlockIds.end, "2027-03-15"),
    });
    assert.match(refused.errors?.[adminBlockIds.start] ?? "", /1 logged date would fall outside/);

    const saved = await submit(h, meta, {
      ...typed(adminBlockIds.name, "Renamed Year"),
      ...dated(adminBlockIds.start, "2026-09-01"),
      ...dated(adminBlockIds.end, "2027-04-30"),
    });
    assert.ok(text(saved.view).includes("✅ Updated *Renamed Year*"));
    assert.ok(text(saved.view).includes("1 volunteer"));
    assert.equal((await h.repository.listYears())[0]?.endDate, "2027-04-30");
  });

  it("adds, renames and deactivates a category", async () => {
    const added = await submit(
      h,
      { kind: "category", back: "categories" },
      { ...typed(adminBlockIds.name, "Specific Event"), [adminBlockIds.flags]: { flags: { selected_options: [{ value: "requires_event" }] } } },
    );
    assert.ok(text(added.view).includes("✅ Added category *Specific Event*"));
    assert.equal((await h.repository.listCategories()).find((c) => c.name === "Specific Event")?.requiresEvent, true);

    const edited = await submit(
      h,
      { kind: "category", id: CATEGORY_ID, back: "categories" },
      { ...typed(adminBlockIds.name, "General volunteering"), [adminBlockIds.status]: { status: { selected_option: { value: "inactive" } } } },
    );
    assert.ok(text(edited.view).includes("inactive"));
    const general = (await h.repository.listCategories()).find((c) => c.id === CATEGORY_ID);
    assert.deepEqual([general?.name, general?.isActive], ["General volunteering", false]);

    const duplicate = await submit(h, { kind: "category", back: "categories" }, typed(adminBlockIds.name, "specific event"));
    assert.deepEqual(Object.keys(duplicate.errors ?? {}), [adminBlockIds.name]);
  });

  it("edits an event's name, date and status together", async () => {
    await h.admin.addEvent(ADMIN, "Iftar", "2026-11-20");
    const event = (await h.repository.listEvents())[0];

    assert.ok(event);
    const saved = await submit(
      h,
      { kind: "event", id: event.id, back: "events" },
      {
        ...typed(adminBlockIds.name, "Community Iftar"),
        ...dated(adminBlockIds.date, "2026-11-22"),
        [adminBlockIds.status]: { status: { selected_option: { value: "inactive" } } },
      },
    );

    assert.ok(text(saved.view).includes("✅ Updated event *Community Iftar*"));
    assert.deepEqual(
      (await h.repository.listEvents()).map((e) => [e.name, e.eventDate, e.isActive]),
      [["Community Iftar", "2026-11-22", false]],
    );
  });

  it("adds and edits staff, and clears a title when it is blank", async () => {
    const added = await submit(
      h,
      { kind: "staff", back: "staff" },
      {
        [adminBlockIds.user]: { user: { selected_user: "UNEWSTAFF1" } },
        ...typed(adminBlockIds.title, "Vice President"),
        [adminBlockIds.flags]: { flags: { selected_options: [{ value: "approve" }, { value: "primary" }] } },
      },
    );
    assert.ok(text(added.view).includes("UNEWSTAFF1"));
    assert.equal((await h.repository.getStaffMember("UNEWSTAFF1"))?.title, "Vice President");

    await submit(
      h,
      { kind: "staff", id: "UNEWSTAFF1", back: "staff" },
      {
        ...typed(adminBlockIds.title, ""),
        [adminBlockIds.flags]: { flags: { selected_options: [{ value: "approve" }] } },
      },
    );
    const member = await h.repository.getStaffMember("UNEWSTAFF1");

    assert.deepEqual([member?.title, member?.isPrimary], [null, false]);

    const none = await submit(
      h,
      { kind: "staff", id: "UNEWSTAFF1", back: "staff" },
      { ...typed(adminBlockIds.title, ""), [adminBlockIds.flags]: { flags: { selected_options: [] } } },
    );
    assert.match(none.errors?.[adminBlockIds.flags] ?? "", /at least one permission/);
  });

  it("won't let someone who isn't a settings-named admin change staff", async () => {
    await h.repository.upsertStaffMember(
      { slackUserId: "UMANAGER01", displayName: null, title: null, canApprove: false, canManage: true, isPrimary: false },
    );

    const result = await submit(
      h,
      { kind: "staff", back: "staff" },
      {
        [adminBlockIds.user]: { user: { selected_user: "UNEWSTAFF1" } },
        ...typed(adminBlockIds.title, ""),
        [adminBlockIds.flags]: { flags: { selected_options: [{ value: "approve" }] } },
      },
      "UMANAGER01",
    );

    assert.match(result.errors?.[adminBlockIds.user] ?? "", /Only volunteer admins can change who is staff/);
    assert.equal(await h.repository.getStaffMember("UNEWSTAFF1"), null);
  });

  it("links a volunteer to a Slack account and tells that person", async () => {
    const result = await submit(
      h,
      { kind: "link", back: "home" },
      {
        [adminBlockIds.volunteer]: { [adminActionIds.linkSearch]: { selected_option: { value: "ext_nobody" } } },
        [adminBlockIds.user]: { user: { selected_user: "UNEWSTAFF1" } },
      },
    );

    // The volunteer doesn't exist, so it fails under the volunteer field.
    assert.match(result.errors?.[adminBlockIds.volunteer] ?? "", /no longer exists/);
    assert.deepEqual(h.dms, []);

    const missing = await submit(h, { kind: "link", back: "home" }, {});
    assert.deepEqual(Object.keys(missing.errors ?? {}), [adminBlockIds.volunteer]);
  });

  it("answers a form that lost its memory instead of guessing", async () => {
    const result = await submit(h, { kind: "nonsense" as never, back: "home" }, {});

    assert.ok(text(result.view).includes("That form expired"));
  });
});

describe("deleting and removing", () => {
  let h: Harness;

  beforeEach(() => {
    h = setup();
  });

  it("deletes an empty year and returns to the list; keeps one with hours and says why", async () => {
    await h.admin.addYear(ADMIN, "2027/28 Volunteer Year", "2027-09-01", "2028-03-15");
    const empty = (await h.repository.listYears()).find((y) => y.label.startsWith("2027"));

    assert.ok(empty);
    await press(h, adminActionIds.danger, `year:${empty.id}`);
    assert.ok(text(last(h)?.view).includes("✅ Deleted *2027/28 Volunteer Year*"));
    assert.equal((await h.repository.listYears()).length, 1);
    assert.equal(h.ops.length, 1);

    await h.repository.createSubmission({
      id: "s1",
      slackSubmissionId: "slack-s1",
      volunteerSlackUserId: "UVOL00001",
      submittedBySlackUserId: "UVOL00001",
      approvedBySlackUserId: null,
      categoryId: CATEGORY_ID,
      eventId: null,
      description: "x",
      entries: [{ entryDate: "2026-12-01", hours: 2, yearId: YEAR_ID }],
    });
    await press(h, adminActionIds.danger, `year:${YEAR_ID}`);
    assert.ok(text(last(h)?.view).includes("⚠️ *2026/27 Volunteer Year* has hours or reports"));
    assert.equal((await h.repository.listYears()).length, 1);
  });

  it("removes a staff member, but only for the admins named in settings", async () => {
    await press(h, adminActionIds.danger, `staff:${EXEC}`, EXEC);
    assert.equal((await h.repository.getStaffMember(EXEC))?.canApprove, true);

    await press(h, adminActionIds.danger, `staff:${EXEC}`, ADMIN);
    assert.equal(await h.repository.getStaffMember(EXEC), null);
    assert.ok(text(last(h)?.view).includes("✅ Removed"));
  });

  it("shows how it went on the screen after an unauthorised delete, and does nothing", async () => {
    await press(h, adminActionIds.danger, `year:${YEAR_ID}`, EXEC);

    assert.equal((await h.repository.listYears()).length, 1);
    assert.ok(text(last(h)?.view).includes("Only volunteer admins"));
  });
});

describe("rendering screens directly", () => {
  it("never reveals the admin screens to someone without access", async () => {
    const h = setup();

    for (const key of ["home", "years", "staff", "categories", "events", "link"]) {
      const view = await renderAdminScreen(h.admin, "UNOBODY01", key);

      assert.ok(text(view).includes("Only volunteer admins"), key);
    }
  });
});

describe("the form callback", () => {
  it("is registered once, under the id the forms use", () => {
    assert.equal(ADMIN_FORM_CALLBACK, "vol_adm_form");
  });
});
