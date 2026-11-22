import type { MyHours } from "../services/volunteer.service.js";
import {
  navButton,
  noticeBlocks,
  setupSummary,
  type AdminViewContext,
} from "./volunteer-admin-views.js";
import {
  formatHours,
  truncate,
  type Block,
  type ModalView,
} from "./volunteer-views.js";

/**
 * The home screens behind the three commands:
 *   /volunteer        everyone
 *   /volunteer-exec   execs (staff who can approve or manage) and admins
 *   /volunteer-admin  admins (admins also get everything execs get)
 *
 * Each screen is a few big buttons. A button replaces the screen with the form
 * or list it leads to.
 */
export const hubActionIds = {
  hours: "vol_hub_hours",
  myHours: "vol_hub_my_hours",
  profile: "vol_hub_profile",
  report: "vol_hub_report",
  letters: "vol_hub_letters",
  pending: "vol_hub_pending",
  hoursFor: "vol_hub_hours_for",
  records: "vol_hub_records",
  back: "vol_hub_back",
} as const;

export type HubActionId = (typeof hubActionIds)[keyof typeof hubActionIds];

/** The three home screens. */
export type HubHome = "member" | "exec" | "admin";

/**
 * Where a ← Back button leads: a home screen, the My hours list, or one
 * volunteer's request list (an admin looking someone up).
 */
export type HubBack =
  | HubHome
  | "my"
  /** The "log hours for someone" picker. */
  | "behalf"
  /** The approvers' queue of pending requests. */
  | "pending"
  | "pending:admin"
  | `records:${string}`
  /** An admin screen, by its key (for example `admin:year:<id>`). */
  | `admin:${string}`;

export function parseHubBack(value: string | undefined): HubBack {
  if (value === "member" || value === "exec" || value === "admin" || value === "my" || value === "behalf" || value === "pending" || value === "pending:admin") {
    return value;
  }

  for (const prefix of ["records:", "admin:"]) {
    if (value?.startsWith(prefix) && value.length > prefix.length) {
      return value as HubBack;
    }
  }

  return "member";
}

export interface HubTier {
  isExec: boolean;
  isAdmin: boolean;
}

function plain(text: string): { type: "plain_text"; text: string } {
  return { type: "plain_text", text };
}

function title(text: string): { type: "plain_text"; text: string } {
  return plain(truncate(text, 24));
}

/**
 * A home-screen button. Its value says which home it was on, so the form it
 * opens knows where its ← Back button should lead.
 */
function button(
  actionId: HubActionId,
  text: string,
  home: HubHome,
  style?: "primary",
): {
  type: "button";
  action_id: HubActionId;
  text: { type: "plain_text"; text: string };
  value: HubHome;
  style?: "primary";
} {
  return {
    type: "button",
    action_id: actionId,
    text: plain(truncate(text, 75)),
    value: home,
    ...(style ? { style } : {}),
  };
}

export function hubBackBlock(target: HubBack, label = "← Back"): Block {
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: hubActionIds.back,
        text: plain(truncate(label, 75)),
        value: target,
      },
    ],
  };
}

/** The same screen with a ← Back button added at the top. */
export function withBack(view: ModalView, target: HubBack): ModalView {
  return {
    ...view,
    blocks: [hubBackBlock(target), ...(view.blocks ?? [])].slice(0, 100),
  };
}

function section(text: string): Block {
  return { type: "section", text: { type: "mrkdwn", text } };
}

export function buildMemberHomeView(
  myHours: MyHours,
  tier: HubTier,
): ModalView {
  const blocks: Block[] = [
    section(
      `*Your volunteer hours*\nApproved: *${formatHours(myHours.approvedHours)} h*   ·   Pending: *${formatHours(myHours.pendingHours)} h*   ·   Disapproved: *${formatHours(myHours.rejectedHours)} h*`,
    ),
    {
      type: "actions",
      elements: [
        button(hubActionIds.hours, "Log hours", "member", "primary"),
        button(hubActionIds.myHours, "My hours", "member"),
        button(hubActionIds.profile, "My profile", "member"),
      ],
    },
  ];

  if (myHours.rejectedHours > 0) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "⚠️ Some of your hours were disapproved. Open *My hours* to fix them and send them back for review.",
        },
      ],
    });
  }

  if (tier.isExec || tier.isAdmin) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: tier.isAdmin
            ? "You also have admin tools: /volunteer-admin (and exec tools: /volunteer-exec)."
            : "You also have exec tools: /volunteer-exec.",
        },
      ],
    });
  }

  return {
    type: "modal",
    title: title("Volunteer hours"),
    close: plain("Close"),
    blocks,
  };
}

export function buildExecHomeView(pendingCount = 0): ModalView {
  return {
    type: "modal",
    title: title("Volunteer exec"),
    close: plain("Close"),
    blocks: [
      section(
        pendingCount > 0
          ? `*Pending requests*\n${pendingCount} ${pendingCount === 1 ? "request is" : "requests are"} waiting for review.`
          : "*Pending requests*\nNothing is waiting for review.",
      ),
      {
        type: "actions",
        elements: [
          button(
            hubActionIds.pending,
            pendingCount > 0 ? `Pending requests (${pendingCount})` : "Pending requests",
            "exec",
            pendingCount > 0 ? "primary" : undefined,
          ),
        ],
      },
      { type: "divider" },
      section(
        "*Reports and letters*\nA combined CSV and PDF report for CCR, or a letter for each volunteer you pick.",
      ),
      {
        type: "actions",
        elements: [
          button(hubActionIds.report, "CCR report", "exec"),
          button(hubActionIds.letters, "Volunteer letters", "exec"),
        ],
      },
    ],
  };
}

export function buildAdminHomeView(
  context: AdminViewContext,
  notice: string | null = null,
): ModalView {
  return {
    type: "modal",
    title: title("Volunteer admin"),
    close: plain("Close"),
    blocks: [
      ...noticeBlocks(notice),
      section(
        "*Volunteers*\nLog hours for a volunteer who isn't on Slack, fix or delete a request, or link a volunteer to their Slack account.",
      ),
      {
        type: "actions",
        elements: [
          button(hubActionIds.pending, "Pending requests", "admin"),
          button(hubActionIds.hoursFor, "Log hours for someone", "admin"),
          button(hubActionIds.records, "Find a volunteer's requests", "admin"),
          navButton("Link to a Slack account", "link"),
        ],
      },
      { type: "divider" },
      section(
        "*Reports and letters*\nA combined CSV and PDF report for CCR, or a letter for each volunteer you pick.",
      ),
      {
        type: "actions",
        elements: [
          button(hubActionIds.report, "CCR report", "admin"),
          button(hubActionIds.letters, "Volunteer letters", "admin"),
        ],
      },
      { type: "divider" },
      section(`*Setup*\n${setupSummary(context)}`),
      {
        type: "actions",
        elements: [
          navButton("Years", "years", undefined, "years"),
          navButton("Staff", "staff", undefined, "staff"),
          navButton("Categories", "categories", undefined, "categories"),
          navButton("Events", "events", undefined, "events"),
        ],
      },
    ],
  };
}

/** A button on a "done" screen: what to do next. */
export interface DoneAction {
  label: string;
  actionId: HubActionId;
  /** The home or Back target the button carries (see HubBack). */
  value: HubBack;
  primary?: boolean;
}

/**
 * The screen shown after saving: what happened, and what to do next. It
 * replaces the form, so the window never just vanishes.
 */
export function buildDoneView(options: {
  title: string;
  body: string;
  actions: DoneAction[];
}): ModalView {
  // Slack rejects a row where two buttons share an action_id, and two "Back"
  // buttons with different targets are legitimate here. The second one onward
  // gets a ":2", ":3"... suffix, which the hub handler ignores (see
  // baseActionId); the target still travels in the button's value.
  const seen = new Map<string, number>();
  const buttons = options.actions.map((action) => {
    const count = (seen.get(action.actionId) ?? 0) + 1;
    seen.set(action.actionId, count);

    return { action, actionId: count === 1 ? action.actionId : `${action.actionId}:${count}` };
  }).map(({ action, actionId }) => ({
    type: "button" as const,
    action_id: actionId,
    text: plain(truncate(action.label, 75)),
    value: action.value,
    ...(action.primary ? { style: "primary" as const } : {}),
  }));

  return {
    type: "modal",
    title: title(options.title),
    close: plain("Close"),
    blocks: [
      section(truncate(options.body, 2900)),
      ...(buttons.length > 0
        ? [{ type: "actions", elements: buttons } as Block]
        : []),
    ],
  };
}
