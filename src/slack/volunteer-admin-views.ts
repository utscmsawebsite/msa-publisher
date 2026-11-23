import type {
  VolunteerCategory,
  VolunteerEvent,
  VolunteerStaffMember,
  VolunteerYear,
  YearStats,
} from "../domain/volunteer.js";
import type { AdminData } from "../services/volunteer-admin.service.js";
import {
  escapeSlackText,
  formatHours,
  truncate,
  type Block,
  type ModalView,
} from "./volunteer-views.js";

/**
 * The admin Setup screens: Years (with each year's page), Staff, Categories,
 * Events, and linking a volunteer to a Slack account. Each list is a set of
 * rows with an Edit/Open button, and every screen has a Back button, because
 * the whole thing lives in one modal that is replaced as you move around.
 *
 * Screens are named by a short "key" (`years`, `year:<id>`, `edit:staff:<id>`,
 * `add:event`, ...). A button's value is the key of the screen it leads to.
 */
export const adminActionIds = {
  /** A button that opens another screen; its value is the screen key. */
  nav: "vol_adm_nav",
  /** The red button inside an edit screen (delete a year, remove staff). */
  danger: "vol_adm_danger",
  /** Opens the report form on a year. */
  yearReport: "vol_adm_year_report",
  linkSearch: "vol_a_search_unlinked",
} as const;

/**
 * Slack rejects a whole view ("invalid_arguments") when two buttons in one row
 * share an action_id. Nav buttons that sit side by side in a row (the Setup row
 * on the admin home) therefore each get their own "slot", which becomes part of
 * the action_id. The screen to open still travels in the button's value.
 */
export const adminNavSlots = ["years", "staff", "categories", "events"] as const;

export type AdminNavSlot = (typeof adminNavSlots)[number];

/** Every action_id a nav button can have; the nav handler is registered on each. */
export const adminNavActionIds: readonly string[] = [
  adminActionIds.nav,
  ...adminNavSlots.map((slot) => `${adminActionIds.nav}:${slot}`),
];

export const ADMIN_FORM_CALLBACK = "vol_adm_form";

export const adminBlockIds = {
  name: "vol_a_name",
  start: "vol_a_start",
  end: "vol_a_end",
  date: "vol_a_date",
  user: "vol_a_user",
  title: "vol_a_title",
  flags: "vol_a_flags",
  status: "vol_a_status",
  volunteer: "vol_a_volunteer",
} as const;

/** The longest list shown on one screen (a modal holds 100 blocks). */
export const MAX_ROWS = 40;

export type FormKind = "year" | "staff" | "category" | "event" | "link";

/** What a form screen remembers, so the submit handler knows what it was for. */
export interface FormMetadata {
  kind: FormKind;
  /** The thing being edited; absent when adding. */
  id?: string;
  /** The screen to go back to (and to show after saving). */
  back: string;
}

export interface AdminViewContext {
  data: AdminData;
  /** Today's date as YYYY-MM-DD in Toronto. */
  today: string;
  /** Only the people listed in the bot's settings may change who is staff. */
  canChangeStaff: boolean;
}

function plain(text: string): { type: "plain_text"; text: string } {
  return { type: "plain_text", text };
}

function title(text: string): { type: "plain_text"; text: string } {
  return plain(truncate(text, 24));
}

function option(text: string, value: string) {
  return { text: plain(truncate(text, 75)), value };
}

function section(text: string, accessory?: object): Block {
  return {
    type: "section",
    text: { type: "mrkdwn", text: truncate(text, 2900) },
    ...(accessory ? { accessory } : {}),
  } as Block;
}

export function navButton(
  text: string,
  key: string,
  style?: "primary",
  /** Only needed when several nav buttons share one row (see adminNavSlots). */
  slot?: AdminNavSlot,
): {
  type: "button";
  action_id: string;
  text: { type: "plain_text"; text: string };
  value: string;
  style?: "primary";
} {
  return {
    type: "button",
    action_id: slot ? `${adminActionIds.nav}:${slot}` : adminActionIds.nav,
    text: plain(truncate(text, 75)),
    value: key,
    ...(style ? { style } : {}),
  };
}

function rowWithButton(text: string, buttonText: string, key: string): Block {
  return section(text, navButton(buttonText, key));
}

function backBlock(key: string, label = "← Back"): Block {
  return { type: "actions", elements: [navButton(label, key)] };
}

/** A line at the top of a screen: a ✅ confirmation, or a ⚠️ warning as written. */
export function noticeBlocks(notice: string | null): Block[] {
  if (!notice) {
    return [];
  }

  const text = notice.startsWith("⚠️") ? notice : `✅ ${notice}`;

  return [{ type: "section", text: { type: "mrkdwn", text: truncate(text, 2900) } }];
}

function note(text: string): Block {
  return { type: "context", elements: [{ type: "mrkdwn", text: truncate(text, 2900) }] };
}

function moreNote(shown: number, total: number, what: string): Block[] {
  return total > shown ? [note(`Showing ${shown} of ${total} ${what}.`)] : [];
}

function screen(name: string, blocks: Block[]): ModalView {
  return {
    type: "modal",
    title: title(name),
    close: plain("Close"),
    blocks: blocks.slice(0, 100),
  };
}

function formScreen(
  name: string,
  metadata: FormMetadata,
  blocks: Block[],
): ModalView {
  return {
    type: "modal",
    callback_id: ADMIN_FORM_CALLBACK,
    private_metadata: JSON.stringify(metadata),
    title: title(name),
    submit: plain("Save"),
    close: plain("Close"),
    blocks: [backBlock(metadata.back), ...blocks].slice(0, 100),
  };
}

export type YearTiming = "current" | "past" | "upcoming";

export function yearTiming(year: VolunteerYear, today: string): YearTiming {
  if (today < year.startDate) {
    return "upcoming";
  }

  return today > year.endDate ? "past" : "current";
}

const timingLabels: Record<YearTiming, string> = {
  current: "● Current",
  past: "Past",
  upcoming: "Upcoming",
};

/** "2026/27  ·  ● Current  ·  ★ Default" (the default tag only on the default year). */
function yearHeading(year: VolunteerYear, today: string): string {
  const tags = [timingLabels[yearTiming(year, today)]];

  if (year.isDefault) {
    tags.push("★ Default");
  }

  return `*${escapeSlackText(truncate(year.label, 60))}*  ·  ${tags.join("  ·  ")}`;
}

export function statsLine(stats: YearStats | undefined): string {
  if (!stats) {
    return "Nothing logged yet.";
  }

  const volunteers = `${stats.volunteers} ${stats.volunteers === 1 ? "volunteer" : "volunteers"}`;

  return [
    volunteers,
    `${formatHours(stats.approvedHours)} h approved`,
    `${formatHours(stats.pendingHours)} h pending`,
    `${formatHours(stats.sentHours)} h sent to CCR`,
  ].join(" · ");
}

function statsFor(data: AdminData, yearId: string): YearStats | undefined {
  return data.yearStats.find((stats) => stats.yearId === yearId);
}

/** Events whose date falls inside the year, earliest first. */
export function eventsInYear(
  events: VolunteerEvent[],
  year: VolunteerYear,
): VolunteerEvent[] {
  return events
    .filter(
      (event) =>
        event.eventDate !== null &&
        event.eventDate >= year.startDate &&
        event.eventDate <= year.endDate,
    )
    .sort((left, right) =>
      (left.eventDate ?? "").localeCompare(right.eventDate ?? ""),
    );
}

function eventLine(event: VolunteerEvent): string {
  return `*${escapeSlackText(truncate(event.name, 60))}*  ·  ${
    event.eventDate ?? "no date"
  }${event.isActive ? "" : "  ·  _inactive_"}`;
}

export function staffRoles(member: VolunteerStaffMember): string {
  return (
    [
      member.canApprove ? "approve" : null,
      member.canManage ? "manage" : null,
      member.isPrimary ? "primary" : null,
    ]
      .filter(Boolean)
      .join(", ") || "no permissions"
  );
}

function categoryLine(category: VolunteerCategory, activeEventCount: number): string {
  const eventNote = !category.requiresEvent
    ? ""
    : activeEventCount === 0
      ? "  ·  volunteers pick an event  ·  ⚠️ no active events yet"
      : `  ·  volunteers pick from ${activeEventCount} active event${activeEventCount === 1 ? "" : "s"}`;

  return `*${escapeSlackText(truncate(category.name, 60))}*${eventNote}${
    category.isActive ? "" : "  ·  _inactive_"
  }`;
}

/** The events a volunteer can choose from: every active one. */
function activeEventsOf(context: AdminViewContext): VolunteerEvent[] {
  return context.data.events.filter((event) => event.isActive);
}

/** The one line under "Setup" on the admin home screen. */
export function setupSummary(context: AdminViewContext): string {
  const { data, today } = context;
  const defaultYear = data.years.find((year) => year.isDefault);
  const current = data.years.find((year) => yearTiming(year, today) === "current");
  const count = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;

  return [
    defaultYear
      ? `Default year: ${escapeSlackText(defaultYear.label)}`
      : current
        ? `Current year: ${escapeSlackText(current.label)}`
        : "No current year",
    count(data.staff.length, "staff member", "staff"),
    count(data.categories.length, "category", "categories"),
    count(data.events.length, "event", "events"),
  ].join(" · ");
}

// --- Years -----------------------------------------------------------------

export function buildYearsView(
  context: AdminViewContext,
  notice: string | null = null,
): ModalView {
  const { data, today } = context;
  const years = [...data.years].sort((left, right) =>
    right.startDate.localeCompare(left.startDate),
  );
  const shown = years.slice(0, MAX_ROWS);

  return screen("Volunteer years", [
    backBlock("home"),
    ...noticeBlocks(notice),
    {
      type: "actions",
      elements: [navButton("+ New year", "add:year", "primary")],
    },
    ...(years.length === 0
      ? [section("No volunteer years yet. Add one so volunteers can log hours.")]
      : shown.map((year) =>
          rowWithButton(
            `${yearHeading(year, today)}\n${year.startDate} to ${year.endDate}\n${statsLine(statsFor(data, year.id))}`,
            "Open",
            `year:${year.id}`,
          ),
        )),
    ...moreNote(shown.length, years.length, "years"),
  ]);
}

export function buildYearView(
  context: AdminViewContext,
  year: VolunteerYear,
  notice: string | null = null,
): ModalView {
  const { data, today } = context;
  const events = eventsInYear(data.events, year);
  const shown = events.slice(0, 25);

  return screen(year.label, [
    backBlock("years", "← All years"),
    ...noticeBlocks(notice),
    section(
      `${yearHeading(year, today)}\n${year.startDate} to ${year.endDate}`,
    ),
    section(`*Logged hours*\n${statsLine(statsFor(data, year.id))}`),
    {
      type: "actions",
      elements: [
        navButton("Edit year", `edit:year:${year.id}`),
        {
          type: "button",
          action_id: adminActionIds.yearReport,
          text: plain("Generate a report"),
          value: year.id,
        },
      ],
    },
    { type: "divider" },
    section(
      `*Events in this year*  (${events.length})\nEvents whose date falls between ${year.startDate} and ${year.endDate}.`,
    ),
    ...(shown.length === 0
      ? [note("No dated events in this year yet.")]
      : shown.map((event) =>
          rowWithButton(
            eventLine(event),
            "Edit",
            `edit:event:${event.id}:year:${year.id}`,
          ),
        )),
    ...moreNote(shown.length, events.length, "events"),
    {
      type: "actions",
      elements: [navButton("+ Add event", `add:event:year:${year.id}`)],
    },
  ]);
}

function dateInput(
  blockId: string,
  label: string,
  initial: string | null,
  optional = false,
): Block {
  return {
    type: "input",
    block_id: blockId,
    ...(optional ? { optional: true } : {}),
    label: plain(label),
    element: {
      type: "datepicker",
      action_id: "date",
      ...(initial ? { initial_date: initial } : {}),
    },
  };
}

function textInput(
  blockId: string,
  label: string,
  initial: string | null,
  options: { optional?: boolean; hint?: string; max?: number } = {},
): Block {
  return {
    type: "input",
    block_id: blockId,
    ...(options.optional ? { optional: true } : {}),
    label: plain(label),
    ...(options.hint ? { hint: plain(options.hint) } : {}),
    element: {
      type: "plain_text_input",
      action_id: "name",
      max_length: options.max ?? 80,
      ...(initial ? { initial_value: truncate(initial, options.max ?? 80) } : {}),
    },
  };
}

function statusInput(isActive: boolean): Block {
  const active = option("Active", "active");
  const inactive = option("Inactive (hidden from the pick-list)", "inactive");

  return {
    type: "input",
    block_id: adminBlockIds.status,
    label: plain("Status"),
    element: {
      type: "radio_buttons",
      action_id: "status",
      options: [active, inactive],
      initial_option: isActive ? active : inactive,
    },
  };
}

function dangerBlock(
  text: string,
  value: string,
  confirmText: string,
): Block {
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: adminActionIds.danger,
        style: "danger",
        text: plain(truncate(text, 75)),
        value,
        confirm: {
          title: plain("Are you sure?"),
          text: { type: "mrkdwn", text: confirmText },
          confirm: plain("Yes"),
          deny: plain("Cancel"),
        },
      },
    ],
  };
}

const defaultYearOption = {
  text: plain("Use as the default year"),
  description: plain("Reports open on this year first. You can still pick any year."),
  value: "default",
};

function defaultYearInput(checked: boolean): Block {
  return {
    type: "input",
    block_id: adminBlockIds.flags,
    optional: true,
    label: plain("Default year"),
    element: {
      type: "checkboxes",
      action_id: "flags",
      options: [defaultYearOption],
      ...(checked ? { initial_options: [defaultYearOption] } : {}),
    },
  };
}

export function buildYearFormView(
  year: VolunteerYear | null,
  stats: YearStats | undefined,
  back: string,
  /** Whether some year is already the default (a first year is pre-ticked). */
  hasDefault = true,
): ModalView {
  const metadata: FormMetadata = {
    kind: "year",
    ...(year ? { id: year.id } : {}),
    back,
  };
  const hasHours = Boolean(stats && stats.volunteers > 0);

  return formScreen(year ? "Edit year" : "New year", metadata, [
    textInput(adminBlockIds.name, "Label", year?.label ?? null, {
      max: 60,
      hint: "For example: 2027/28 Volunteer Year",
    }),
    dateInput(adminBlockIds.start, "Start date", year?.startDate ?? null),
    dateInput(adminBlockIds.end, "End date", year?.endDate ?? null),
    defaultYearInput(year ? year.isDefault : !hasDefault),
    ...(year
      ? [
          note(
            "You can rename a year at any time. Its dates can only change while every date already logged stays inside them.",
          ),
          hasHours
            ? note("This year has hours logged against it, so it can't be deleted.")
            : dangerBlock(
                "Delete this year",
                `year:${year.id}`,
                "Delete this volunteer year? It has nothing logged against it, so nothing else is affected.",
              ),
        ]
      : []),
  ]);
}

// --- Staff -----------------------------------------------------------------

export function buildStaffView(
  context: AdminViewContext,
  notice: string | null = null,
): ModalView {
  const { data, canChangeStaff } = context;
  const staff = [...data.staff].sort(
    (left, right) =>
      Number(right.isPrimary) - Number(left.isPrimary) ||
      (left.displayName ?? left.slackUserId).localeCompare(
        right.displayName ?? right.slackUserId,
      ),
  );
  const shown = staff.slice(0, MAX_ROWS);

  return screen("Volunteer staff", [
    backBlock("home"),
    ...noticeBlocks(notice),
    ...(canChangeStaff
      ? [
          {
            type: "actions",
            elements: [navButton("+ Add staff member", "add:staff", "primary")],
          } as Block,
        ]
      : [
          note(
            "Only the volunteer admins named in the bot's settings can change who is staff.",
          ),
        ]),
    ...(shown.length === 0
      ? [section("Nobody yet.")]
      : shown.map((member) => {
          const text = `<@${member.slackUserId}>${member.title ? `  ·  ${escapeSlackText(truncate(member.title, 60))}` : ""}\n${staffRoles(member)}`;

          return canChangeStaff
            ? rowWithButton(text, "Edit", `edit:staff:${member.slackUserId}`)
            : section(text);
        })),
    ...moreNote(shown.length, staff.length, "staff"),
  ]);
}

export function buildStaffFormView(
  member: VolunteerStaffMember | null,
  back: string,
): ModalView {
  const metadata: FormMetadata = {
    kind: "staff",
    ...(member ? { id: member.slackUserId } : {}),
    back,
  };
  const approve = option("Can approve hours", "approve");
  const manage = option("Can manage categories, events and years", "manage");
  const primary = option(
    "Primary approver (@mentioned on each request)",
    "primary",
  );
  const initial = [
    member?.canApprove ? approve : null,
    member?.canManage ? manage : null,
    member?.isPrimary ? primary : null,
  ].filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);

  return formScreen(member ? "Edit staff member" : "Add staff member", metadata, [
    member
      ? section(`Editing <@${member.slackUserId}>`)
      : {
          type: "input",
          block_id: adminBlockIds.user,
          label: plain("Slack user"),
          element: { type: "users_select", action_id: "user" },
        },
    textInput(adminBlockIds.title, "Title (printed under their signature on letters)", member?.title ?? null, {
      optional: true,
      hint: "For example: Vice President Community Engagement. Leave blank for none.",
    }),
    {
      type: "input",
      block_id: adminBlockIds.flags,
      optional: true,
      label: plain("Permissions"),
      element: {
        type: "checkboxes",
        action_id: "flags",
        options: [approve, manage, primary],
        ...(initial.length > 0 ? { initial_options: initial } : {}),
      },
    },
    ...(member
      ? [
          dangerBlock(
            "Remove from staff",
            `staff:${member.slackUserId}`,
            `Remove <@${member.slackUserId}> from volunteer staff? They stop being able to approve or manage.`,
          ),
        ]
      : []),
  ]);
}

// --- Categories ------------------------------------------------------------

export function buildCategoriesView(
  context: AdminViewContext,
  notice: string | null = null,
): ModalView {
  const categories = [...context.data.categories].sort(
    (left, right) => left.sortOrder - right.sortOrder,
  );
  const shown = categories.slice(0, MAX_ROWS);

  const activeEventCount = activeEventsOf(context).length;

  return screen("Categories", [
    backBlock("home"),
    ...noticeBlocks(notice),
    {
      type: "actions",
      elements: [navButton("+ Add category", "add:category", "primary")],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "A category is the kind of volunteering. One marked *volunteers pick an event* shows the active events (see *Events*) as a dropdown.",
        },
      ],
    },
    ...(shown.length === 0
      ? [section("No categories yet.")]
      : shown.map((category) =>
          rowWithButton(
            categoryLine(category, activeEventCount),
            "Edit",
            `edit:category:${category.id}`,
          ),
        )),
    ...moreNote(shown.length, categories.length, "categories"),
  ]);
}

export function buildCategoryFormView(
  category: VolunteerCategory | null,
  back: string,
  /** The events volunteers can currently choose from (shown when editing). */
  activeEvents: readonly VolunteerEvent[] = [],
): ModalView {
  const metadata: FormMetadata = {
    kind: "category",
    ...(category ? { id: category.id } : {}),
    back,
  };

  const names = activeEvents
    .slice(0, 5)
    .map((event) => `*${escapeSlackText(truncate(event.name, 40))}*`);
  const more = activeEvents.length - names.length;
  const explanation = !category
    ? null
    : category.requiresEvent
      ? activeEvents.length === 0
        ? "Volunteers must pick an event for this category, but there are no active events yet. Add one under *Events*, or volunteers can't log hours here."
        : `Volunteers must pick one of the active events: ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}. Manage them under *Events*.`
      : "Volunteers don't pick an event for this category.";

  return formScreen(category ? "Edit category" : "Add category", metadata, [
    ...(explanation
      ? [
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `${explanation} Whether a category asks for an event is set when it's created and can't be changed. To change it, add a new category.`,
              },
            ],
          } as Block,
        ]
      : []),
    textInput(adminBlockIds.name, "Name", category?.name ?? null, { max: 60 }),
    ...(category
      ? [statusInput(category.isActive)]
      : [
          {
            type: "input",
            block_id: adminBlockIds.flags,
            optional: true,
            label: plain("Options"),
            element: {
              type: "checkboxes",
              action_id: "flags",
              options: [
                option(
                  "Volunteers must pick an event (like Specific Event)",
                  "requires_event",
                ),
              ],
            },
          } as Block,
        ]),
  ]);
}

// --- Events ----------------------------------------------------------------

export function buildEventsView(
  context: AdminViewContext,
  notice: string | null = null,
): ModalView {
  const events = [...context.data.events].sort((left, right) =>
    (right.eventDate ?? "").localeCompare(left.eventDate ?? ""),
  );
  const shown = events.slice(0, MAX_ROWS);

  return screen("Events", [
    backBlock("home"),
    ...noticeBlocks(notice),
    {
      type: "actions",
      elements: [navButton("+ Add event", "add:event", "primary")],
    },
    note("Events are what volunteers pick for the Specific Event category. They also appear under the year their date falls in."),
    ...(shown.length === 0
      ? [section("No events yet.")]
      : shown.map((event) =>
          rowWithButton(eventLine(event), "Edit", `edit:event:${event.id}`),
        )),
    ...moreNote(shown.length, events.length, "events"),
  ]);
}

export function buildEventFormView(
  event: VolunteerEvent | null,
  back: string,
  suggestedDate: string | null = null,
): ModalView {
  const metadata: FormMetadata = {
    kind: "event",
    ...(event ? { id: event.id } : {}),
    back,
  };

  return formScreen(event ? "Edit event" : "Add event", metadata, [
    textInput(adminBlockIds.name, "Event name", event?.name ?? null, { max: 80 }),
    dateInput(adminBlockIds.date, "Event date (optional)", event?.eventDate ?? suggestedDate, true),
    ...(event ? [statusInput(event.isActive)] : []),
  ]);
}

// --- Linking a volunteer to Slack -----------------------------------------

export function buildLinkFormView(back: string): ModalView {
  const metadata: FormMetadata = { kind: "link", back };

  return formScreen("Link to Slack", metadata, [
    section(
      "A volunteer an admin added without Slack is linked automatically when they sign in on Slack with the same student number and UTORid (or email). Use this when that match was refused, for example because a detail was typed differently.",
    ),
    {
      type: "input",
      block_id: adminBlockIds.volunteer,
      label: plain("Volunteer (not yet on Slack)"),
      element: {
        type: "external_select",
        action_id: adminActionIds.linkSearch,
        placeholder: plain("Start typing a name or student number"),
        min_query_length: 1,
      },
    },
    {
      type: "input",
      block_id: adminBlockIds.user,
      label: plain("Their Slack account"),
      element: { type: "users_select", action_id: "user" },
    },
  ]);
}
