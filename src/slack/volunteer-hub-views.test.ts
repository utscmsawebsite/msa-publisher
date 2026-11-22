import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adminActionIds, adminNavActionIds } from "./volunteer-admin-views.js";
import {
  buildAdminHomeView,
  buildExecHomeView,
  buildMemberHomeView,
  hubBackBlock,
  parseHubBack,
  withBack,
  hubActionIds,
} from "./volunteer-hub-views.js";
import { buildLoadingView } from "./volunteer-views.js";

const adminContext = {
  data: {
    categories: [],
    events: [],
    staff: [],
    years: [
      { id: "Y1", label: "2026/27 Volunteer Year", startDate: "2026-09-01", endDate: "2027-03-15" },
    ],
    yearStats: [],
  },
  today: "2026-11-15",
  canChangeStaff: true,
};

const hours = {
  rows: [],
  approvedHours: 12.5,
  pendingHours: 2,
  rejectedHours: 0,
};

/** Every button's action id on a screen, in order. */
function buttonIds(view: { blocks?: unknown }): string[] {
  const blocks = (view.blocks ?? []) as Array<{
    type: string;
    elements?: Array<{ type: string; action_id?: string }>;
  }>;

  return blocks
    .filter((block) => block.type === "actions")
    .flatMap((block) => block.elements ?? [])
    .filter((element) => element.type === "button")
    .map((element) => element.action_id ?? "");
}

function allText(view: { blocks?: unknown }): string {
  return JSON.stringify(view.blocks ?? []);
}

describe("the three home screens", () => {
  it("/volunteer offers log hours, my hours and my profile, and shows the totals", () => {
    const view = buildMemberHomeView(hours, { isExec: false, isAdmin: false });

    assert.deepEqual(buttonIds(view), [
      hubActionIds.hours,
      hubActionIds.myHours,
      hubActionIds.profile,
    ]);
    assert.ok(allText(view).includes("12.5 h"));
    assert.ok(allText(view).includes("2 h"));
  });

  it("only points execs and admins at their own commands", () => {
    const member = allText(buildMemberHomeView(hours, { isExec: false, isAdmin: false }));
    const exec = allText(buildMemberHomeView(hours, { isExec: true, isAdmin: false }));
    const admin = allText(buildMemberHomeView(hours, { isExec: true, isAdmin: true }));

    assert.ok(!member.includes("/volunteer-exec") && !member.includes("/volunteer-admin"));
    assert.ok(exec.includes("/volunteer-exec") && !exec.includes("/volunteer-admin"));
    assert.ok(admin.includes("/volunteer-admin") && admin.includes("/volunteer-exec"));
  });

  it("/volunteer-exec offers the pending queue, the CCR report and volunteer letters", () => {
    assert.deepEqual(buttonIds(buildExecHomeView()), [
      hubActionIds.pending,
      hubActionIds.report,
      hubActionIds.letters,
    ]);
  });

  it("/volunteer-admin offers everything an exec gets, plus the admin tools", () => {
    const admin = buttonIds(buildAdminHomeView(adminContext));

    for (const execButton of buttonIds(buildExecHomeView())) {
      assert.ok(admin.includes(execButton), `admin screen is missing ${execButton}`);
    }

    for (const adminButton of [
      hubActionIds.hoursFor,
      hubActionIds.records,
      adminActionIds.nav,
    ]) {
      assert.ok(admin.includes(adminButton), `admin screen is missing ${adminButton}`);
    }
  });

  it("gives every button its own action id, and the hub handler's prefix", () => {
    const ids = [
      ...buttonIds(buildMemberHomeView(hours, { isExec: true, isAdmin: true })),
      ...buttonIds(buildExecHomeView()),
      ...buttonIds(buildAdminHomeView(adminContext)),
      ...buttonIds(withBack(buildLoadingView("x"), "member")),
    ];

    assert.ok(ids.every((id) => id.startsWith("vol_hub_") || adminNavActionIds.includes(id)));
    assert.equal(
      new Set(Object.values(hubActionIds)).size,
      Object.values(hubActionIds).length,
    );
  });
});

describe("the admin home screen", () => {
  it("leads to every setup section and the link form, by screen key", () => {
    const view = buildAdminHomeView(adminContext);
    const keys = ((view.blocks ?? []) as Array<{ elements?: Array<{ value?: string; action_id?: string }> }>)
      .flatMap((block) => block.elements ?? [])
      .filter((element) => adminNavActionIds.includes(element.action_id ?? ""))
      .map((element) => element.value);

    assert.deepEqual(keys, ["link", "years", "staff", "categories", "events"]);
  });

  it("summarises the setup, including the current year", () => {
    assert.ok(allText(buildAdminHomeView(adminContext)).includes("Current year: 2026/27 Volunteer Year"));
  });

  it("shows a warning exactly as written and a confirmation with a tick", () => {
    assert.ok(allText(buildAdminHomeView(adminContext, "⚠️ Careful")).includes("⚠️ Careful"));
    assert.ok(!allText(buildAdminHomeView(adminContext, "⚠️ Careful")).includes("✅"));
    assert.ok(allText(buildAdminHomeView(adminContext, "Saved it")).includes("✅ Saved it"));
  });
});

describe("home screen buttons remember which home they were on", () => {
  const valuesOf = (view: { blocks?: unknown }) =>
    ((view.blocks ?? []) as Array<{ elements?: Array<{ action_id?: string; value?: string }> }>)
      .flatMap((block) => block.elements ?? [])
      .filter((element) => element.action_id?.startsWith("vol_hub_"))
      .map((element) => element.value);

  it("tags each button with the home it is on, so the form can go back there", () => {
    assert.deepEqual(valuesOf(buildMemberHomeView(hours, { isExec: false, isAdmin: false })), ["member", "member", "member"]);
    assert.deepEqual(valuesOf(buildExecHomeView()), ["exec", "exec", "exec"]);
    assert.deepEqual(valuesOf(buildAdminHomeView(adminContext)), ["admin", "admin", "admin", "admin", "admin"]);
  });
});

describe("the Back button", () => {
  it("is added at the top of a screen, with the target it leads to", () => {
    const view = withBack(buildLoadingView("Log hours"), "admin");

    assert.deepEqual(buttonIds(view), [hubActionIds.back]);
    assert.deepEqual(view.blocks?.[0], hubBackBlock("admin"));
    assert.equal(view.blocks?.length, 2);
  });

  it("never pushes a screen past Slack's 100-block limit", () => {
    const full = {
      ...buildLoadingView("x"),
      blocks: Array.from({ length: 100 }, () => ({ type: "divider" as const })),
    };

    assert.equal(withBack(full, "member").blocks?.length, 100);
  });

  it("only accepts targets it knows, and falls back to the member home", () => {
    assert.equal(parseHubBack("exec"), "exec");
    assert.equal(parseHubBack("admin"), "admin");
    assert.equal(parseHubBack("my"), "my");
    assert.equal(parseHubBack("records:ext_abc"), "records:ext_abc");
    assert.equal(parseHubBack("records:"), "member");
    assert.equal(parseHubBack("admin:year:abc"), "admin:year:abc");
    assert.equal(parseHubBack("admin:"), "member");
    assert.equal(parseHubBack("somewhere else"), "member");
    assert.equal(parseHubBack(undefined), "member");
  });
});

describe("the exec home's pending count", () => {
  it("says how many requests are waiting, and highlights the button only then", () => {
    const none = allText(buildExecHomeView(0));
    const some = allText(buildExecHomeView(3));
    const one = allText(buildExecHomeView(1));

    assert.ok(none.includes("Nothing is waiting for review"));
    assert.ok(!none.includes('"style":"primary"'));
    assert.ok(some.includes("3 requests are waiting"));
    assert.ok(some.includes("Pending requests (3)"));
    assert.ok(some.includes('"style":"primary"'));
    assert.ok(one.includes("1 request is waiting"));
  });

  it("accepts the queue as a Back target", () => {
    assert.equal(parseHubBack("pending"), "pending");
    assert.equal(parseHubBack("pending:admin"), "pending:admin");
  });
});

describe("the member home", () => {
  it("nudges you to fix disapproved hours, and only then", () => {
    const quiet = allText(buildMemberHomeView(hours, { isExec: false, isAdmin: false }));
    const nudge = allText(
      buildMemberHomeView({ ...hours, rejectedHours: 3 }, { isExec: false, isAdmin: false }),
    );

    assert.ok(!quiet.includes("disapproved. Open"));
    assert.ok(nudge.includes("Some of your hours were disapproved"));
  });
});
