import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { VolunteerServices } from "../volunteer-application.js";
import type { SlackClient } from "./volunteer-context.js";
import { hubActionIds } from "./volunteer-hub-views.js";
import { registerVolunteerHubs, type VolunteerFlows } from "./volunteer-hubs.js";

type Handler = (args: Record<string, unknown>) => Promise<void>;

interface Harness {
  commands: Map<string, Handler>;
  actions: Array<{ matcher: RegExp; handler: Handler }>;
  views: Array<{ kind: "open" | "update"; viewId: string | null; view: { title?: { text: string }; blocks?: unknown } }>;
  ops: string[];
  flowCalls: string[];
  responses: string[];
  failFlow: boolean;
}

function setup(who: { admins?: string[]; execs?: string[] } = {}): Harness {
  const h: Harness = {
    commands: new Map(),
    actions: [],
    views: [],
    ops: [],
    flowCalls: [],
    responses: [],
    failFlow: false,
  };
  const admins = new Set(who.admins ?? []);
  const execs = new Set([...(who.execs ?? []), ...admins]);

  const app = {
    command: (name: string, handler: Handler) => h.commands.set(name, handler),
    action: (matcher: RegExp, handler: Handler) => h.actions.push({ matcher, handler }),
  };
  const services = {
    admin: {
      canManage: async (id: string) => admins.has(id),
      isStaffAdmin: (id: string) => admins.has(id),
      loadData: async () => ({
        categories: [],
        events: [],
        staff: [],
        years: [{ id: "Y1", label: "2026/27 Volunteer Year", startDate: "2026-09-01", endDate: "2027-03-15", isDefault: false }],
        yearStats: [],
      }),
    },
    reports: { canUseReports: async (id: string) => execs.has(id) },
    volunteer: {
      getPendingQueue: async (id: string) => (execs.has(id) ? { requests: [], total: 2, canApprove: true } : null),
      getMyHours: async () => ({ rows: [], approvedHours: 3, pendingHours: 1, rejectedHours: 0 }),
    },
  } as unknown as VolunteerServices;
  const flow = (name: string) => async (_client: SlackClient, viewId: string, userId: string, home?: string) => {
    h.flowCalls.push(`${name}:${viewId}:${userId}:${home ?? "-"}`);
    if (h.failFlow) {
      throw new Error("boom");
    }
  };
  const flows: VolunteerFlows = {
    beginHours: flow("hours"),
    beginHoursFor: flow("hoursFor"),
    beginProfile: flow("profile"),
    beginMyHours: flow("myHours"),
    beginRecords: flow("records"),
    beginReport: flow("report"),
    beginLetters: flow("letters"),
    beginPending: async (_client, viewId, userId, home) => {
      h.flowCalls.push(`pending:${viewId}:${userId}:${home ?? "-"}`);
    },
    showRecordsFor: async (_client, viewId, userId, volunteerKey) => {
      h.flowCalls.push(`recordsFor:${viewId}:${userId}:${volunteerKey}`);
    },
  };

  registerVolunteerHubs(
    {
      app: app as never,
      background: async (_name, task) => task(),
      opsLog: async (_client, text) => {
        h.ops.push(text);
      },
      sendDirectMessage: async () => true,
    },
    services,
    flows,
  );

  (h as Harness & { client: unknown }).client = {
    views: {
      open: async (args: { view: never }) => {
        h.views.push({ kind: "open", viewId: null, view: args.view });
        return { view: { id: "V1" } };
      },
      update: async (args: { view_id: string; view: never }) => {
        h.views.push({ kind: "update", viewId: args.view_id, view: args.view });
        return {};
      },
    },
  };

  return h;
}

const clientOf = (h: Harness) => (h as Harness & { client: unknown }).client;

async function runCommand(h: Harness, name: string, userId: string): Promise<void> {
  await h.commands.get(name)?.({
    ack: async () => undefined,
    command: { trigger_id: "T1", user_id: userId },
    client: clientOf(h),
    respond: async ({ text }: { text: string }) => {
      h.responses.push(text);
    },
  });
}

async function clickButton(
  h: Harness,
  actionId: string,
  userId: string,
  withView = true,
  value?: string,
): Promise<void> {
  const target = h.actions.find((entry) => entry.matcher.test(actionId));

  await target?.handler({
    ack: async () => undefined,
    action: { action_id: actionId, ...(value ? { value } : {}) },
    body: { user: { id: userId }, ...(withView ? { view: { id: "V9" } } : {}) },
    client: clientOf(h),
  });
}

const finalView = (h: Harness) => h.views.at(-1)?.view;
const text = (view: unknown) => JSON.stringify(view);

describe("the three commands", () => {
  let h: Harness;

  beforeEach(() => {
    h = setup({ admins: ["UADMIN"], execs: ["UEXEC"] });
  });

  it("registers exactly /volunteer, /volunteer-exec and /volunteer-admin", () => {
    assert.deepEqual([...h.commands.keys()].sort(), ["/volunteer", "/volunteer-admin", "/volunteer-exec"]);
  });

  it("opens a loading view first, then the member home", async () => {
    await runCommand(h, "/volunteer", "UMEMBER");

    assert.equal(h.views[0]?.kind, "open");
    assert.equal(h.views[1]?.kind, "update");
    assert.equal(h.views[1]?.viewId, "V1");
    assert.ok(text(finalView(h)).includes(hubActionIds.hours));
    assert.ok(!text(finalView(h)).includes("/volunteer-exec"));
  });

  it("lets execs open /volunteer-exec but turns members away and logs it", async () => {
    await runCommand(h, "/volunteer-exec", "UEXEC");
    assert.ok(text(finalView(h)).includes(hubActionIds.report));
    assert.deepEqual(h.ops, []);

    await runCommand(h, "/volunteer-exec", "UMEMBER");
    assert.ok(text(finalView(h)).includes("Only volunteer execs and admins"));
    assert.ok(!text(finalView(h)).includes(hubActionIds.report));
    assert.equal(h.ops.length, 1);
    assert.ok(String(h.ops[0]).includes("UMEMBER"));
  });

  it("lets only admins open /volunteer-admin, execs included being turned away", async () => {
    await runCommand(h, "/volunteer-admin", "UADMIN");
    assert.ok(text(finalView(h)).includes("vol_adm_nav"));

    for (const user of ["UEXEC", "UMEMBER"]) {
      await runCommand(h, "/volunteer-admin", user);
      assert.ok(text(finalView(h)).includes("Only volunteer admins"), user);
      assert.ok(!text(finalView(h)).includes("vol_adm_nav"), user);
    }

    assert.equal(h.ops.length, 2);
  });

  it("gives admins the exec screen too", async () => {
    await runCommand(h, "/volunteer-exec", "UADMIN");

    assert.ok(text(finalView(h)).includes(hubActionIds.report));
  });

  it("tells the user when a home screen can't be opened, instead of failing silently", async () => {
    const broken = setup();
    (clientOf(broken) as { views: { open: () => Promise<never> } }).views.open = async () => {
      throw new Error("slack down");
    };

    await runCommand(broken, "/volunteer", "UMEMBER");

    assert.deepEqual(broken.responses, ["Sorry, /volunteer could not be opened. Please try again."]);
  });
});

describe("the home-screen buttons", () => {
  let h: Harness;

  beforeEach(() => {
    h = setup({ admins: ["UADMIN"] });
  });

  const cases: Array<[string, string]> = [
    [hubActionIds.hours, "hours"],
    [hubActionIds.myHours, "myHours"],
    [hubActionIds.profile, "profile"],
    [hubActionIds.report, "report"],
    [hubActionIds.letters, "letters"],
    [hubActionIds.pending, "pending"],
    [hubActionIds.hoursFor, "hoursFor"],
    [hubActionIds.records, "records"],
  ];

  for (const [actionId, flow] of cases) {
    it(`${actionId} shows a loading view, then starts ${flow} on the same screen`, async () => {
      await clickButton(h, actionId, "UADMIN", true, "admin");

      assert.equal(h.views[0]?.kind, "update");
      assert.equal(h.views[0]?.viewId, "V9");
      assert.deepEqual(h.flowCalls, [`${flow}:V9:UADMIN:admin`]);
    });
  }

  it("shows one error message, on the same screen, when a flow fails", async () => {
    h.failFlow = true;

    await clickButton(h, hubActionIds.hours, "UADMIN");

    assert.equal(h.views.at(-1)?.viewId, "V9");
    assert.ok(text(finalView(h)).includes("something went wrong"));
  });

  it("tells a form which home it was opened from, so its Back button can return there", async () => {
    await clickButton(h, hubActionIds.report, "UADMIN", true, "exec");
    await clickButton(h, hubActionIds.hours, "UADMIN", true, "member");
    await clickButton(h, hubActionIds.hours, "UADMIN");

    assert.deepEqual(h.flowCalls, ["report:V9:UADMIN:exec", "hours:V9:UADMIN:member", "hours:V9:UADMIN:-"]);
  });

  it("goes back to whichever home a screen came from", async () => {
    await clickButton(h, hubActionIds.back, "UADMIN", true, "member");
    assert.ok(text(finalView(h)).includes(hubActionIds.hours));

    await clickButton(h, hubActionIds.back, "UADMIN", true, "exec");
    assert.ok(text(finalView(h)).includes(hubActionIds.report));
    assert.ok(!text(finalView(h)).includes(hubActionIds.hoursFor));

    await clickButton(h, hubActionIds.back, "UADMIN", true, "admin");
    assert.ok(text(finalView(h)).includes(hubActionIds.hoursFor));

    assert.ok(h.views.every((entry) => entry.viewId === "V9"));
    assert.deepEqual(h.flowCalls, []);
  });

  it("goes back to an admin screen, such as a year's page, by its key", async () => {
    await clickButton(h, hubActionIds.back, "UADMIN", true, "admin:year:Y1");

    assert.ok(text(finalView(h)).includes("2026/27 Volunteer Year"));
    assert.ok(text(finalView(h)).includes("Generate a report"));
    assert.deepEqual(h.flowCalls, []);
  });

  it("goes back to the pending queue, on the home it came from", async () => {
    await clickButton(h, hubActionIds.back, "UADMIN", true, "pending");
    await clickButton(h, hubActionIds.back, "UADMIN", true, "pending:admin");

    assert.deepEqual(h.flowCalls, ["pending:V9:UADMIN:exec", "pending:V9:UADMIN:admin"]);
  });

  it("goes back to My hours, or to one volunteer's requests", async () => {
    await clickButton(h, hubActionIds.back, "UADMIN", true, "my");
    await clickButton(h, hubActionIds.back, "UADMIN", true, "records:ext_abc");

    assert.deepEqual(h.flowCalls, ["myHours:V9:UADMIN:-", "recordsFor:V9:UADMIN:ext_abc"]);
  });

  it("goes back to the member home when a Back button has no usable target", async () => {
    await clickButton(h, hubActionIds.back, "UADMIN");
    await clickButton(h, hubActionIds.back, "UADMIN", true, "who knows");

    for (const entry of h.views) {
      assert.ok(text(entry.view).includes(hubActionIds.hours));
    }
    assert.equal(h.views.length, 2);
  });

  it("doesn't show someone a home screen they have no right to when going back to it", async () => {
    const member = setup({ admins: ["UADMIN"] });

    await clickButton(member, hubActionIds.back, "UMEMBER", true, "admin");

    assert.ok(text(member.views.at(-1)?.view).includes("Only volunteer admins"));
    assert.ok(!text(member.views.at(-1)?.view).includes(hubActionIds.hoursFor));
  });

  it("ignores a click that didn't come from a modal, and unknown buttons", async () => {
    await clickButton(h, hubActionIds.hours, "UADMIN", false);
    await clickButton(h, "vol_hub_unknown", "UADMIN");

    assert.deepEqual(h.views, []);
    assert.deepEqual(h.flowCalls, []);
  });
});
