import type { types } from "@slack/bolt";
import {
  hasSlackAccount,
  studentTypeLabels,
  type StudentType,
  type SubmissionStatus,
  type VolunteerProfile,
  type VolunteerSubmission,
} from "../domain/volunteer.js";
import {
  daysBetween,
  MAX_DESCRIPTION_LENGTH,
  MAX_ENTRIES_PER_SUBMISSION,
  MAX_HOURS_PER_DAY,
  todayInToronto,
  type VolunteerFormData,
} from "../services/volunteer.service.js";

export type ModalView = types.ModalView;
export type Block = types.KnownBlock;

export const callbackIds = {
  recordsPick: "vol_records_pick",
  profileType: "vol_profile_type",
  profileForm: "vol_profile_form",
  hoursForm: "vol_hours_form",
  rejectReason: "vol_reject_reason",
} as const;

export const actionIds = {
  /**
   * The Category dropdown on the hours form. Choosing one redraws the form, so
   * the Event dropdown appears only for a category that asks for an event.
   */
  category: "category",
  editRequest: "vol_edit_request",
  searchVolunteer: "vol_search_volunteer",
  /** The search box on the "log hours for someone" picker. */
  behalfFind: "vol_behalf_find",
  /** The "+ New volunteer" button on that picker. */
  behalfNew: "vol_behalf_new",
  addDate: "vol_add_date",
  removeDate: "vol_remove_date",
  approve: "vol_approve",
  disapprove: "vol_disapprove",
} as const;

export const blockIds = {
  recordsVolunteer: "vol_records_volunteer",
  deleteRequest: "vol_delete_request",
  studentType: "vol_p_type",
  firstName: "vol_p_first",
  lastName: "vol_p_last",
  preferredEmail: "vol_p_pref_email",
  email: "vol_p_email",
  utorid: "vol_p_utorid",
  studentNumber: "vol_p_student_number",
  category: "vol_category",
  event: "vol_event",
  description: "vol_description",
  rowActions: "vol_row_actions",
  decisionActions: "vol_decision_actions",
  reason: "vol_reason",
  date: (index: number) => `vol_date_${index}`,
  hours: (index: number) => `vol_hours_${index}`,
} as const;

export type ProfileMode = "onboard" | "edit";

export interface StateValueLike {
  value?: string | null | undefined;
  selected_date?: string | null | undefined;
  selected_user?: string | null | undefined;
  selected_users?: string[] | null | undefined;
  selected_option?: { value?: string | undefined } | null | undefined;
  selected_options?:
    | Array<{
        value?: string | undefined;
        text?: { text?: string | undefined } | undefined;
      }>
    | null
    | undefined;
}

export type StateValuesLike = Record<
  string,
  Record<string, StateValueLike | undefined> | undefined
>;

export interface HoursFormValues {
  categoryId: string | null;
  eventId: string | null;
  description: string;
  rows: Array<{ date: string | null; hours: string }>;
}

export const statusLabels: Record<SubmissionStatus, string> = {
  pending: "⏳ Pending",
  approved: "✅ Approved",
  rejected: "❌ Disapproved",
};

/** "2026-11-12" -> "Nov 12, 2026" (the date itself, never shifted by a timezone). */
export function formatDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);

  if (!year || !month || !day) {
    return isoDate;
  }

  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function escapeSlackText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength
    ? value
    : `${value.slice(0, maximumLength - 1)}…`;
}

export function formatHours(hours: number): string {
  return String(Number(hours.toFixed(2)));
}

function parsePgTimestamp(value: string): Date {
  return new Date(
    value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"),
  );
}

function plain(text: string): { type: "plain_text"; text: string } {
  return { type: "plain_text", text };
}

export function parseJsonMetadata<T extends object>(value: string): Partial<T> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Partial<T>)
      : {};
  } catch {
    return {};
  }
}

export function buildLoadingView(
  title: string,
  text = "Loading…",
): ModalView {
  return {
    type: "modal",
    title: plain(truncate(title, 24)),
    close: plain("Cancel"),
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text },
      },
    ],
  };
}

export function buildMessageView(title: string, text: string): ModalView {
  return {
    type: "modal",
    title: plain(truncate(title, 24)),
    close: plain("Close"),
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
  };
}

export interface ProfileTypeMetadata {
  mode: ProfileMode;
  existing: VolunteerProfile | null;
  /** Set when an exec is entering details for another volunteer. */
  forUserId?: string | null;
  forName?: string | null;
}

/** The volunteer an exec is entering hours for (not the exec themselves). */
export interface VolunteerTarget {
  id: string;
  name: string | null;
}

export function targetFromMetadata(metadata: {
  forUserId?: string | null | undefined;
  forName?: string | null | undefined;
}): VolunteerTarget | null {
  return metadata.forUserId
    ? { id: metadata.forUserId, name: metadata.forName ?? null }
    : null;
}

function targetMetadata(target: VolunteerTarget | null) {
  return { forUserId: target?.id ?? null, forName: target?.name ?? null };
}

export function volunteerOption(profile: VolunteerProfile): {
  text: { type: "plain_text"; text: string };
  value: string;
} {
  const detail = profile.utorid ?? profile.studentNumber;
  const suffix = hasSlackAccount(profile.slackUserId) ? "" : " · no Slack";

  return {
    text: plain(truncate(`${profile.fullName} · ${detail}${suffix}`, 75)),
    value: profile.slackUserId,
  };
}

export function buildBehalfPickView(): ModalView {
  return {
    type: "modal",
    title: plain("Log hours for someone"),
    close: plain("Close"),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Log volunteer hours on someone else's behalf. They don't need a Slack account. Because *you* are entering them, they're approved straight away and marked as entered by you.",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Find a volunteer*\nAnyone who already has a record shows up, whether or not they're on Slack.",
        },
      },
      {
        type: "actions",
        block_id: "vol_behalf_find_block",
        elements: [
          {
            type: "external_select",
            action_id: actionIds.behalfFind,
            placeholder: plain("Search by name, UTORid, student number or email"),
            min_query_length: 1,
          },
        ],
      },
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Not in the list?*\nAdd them as a new volunteer. You'll enter their details first.",
        },
      },
      {
        type: "actions",
        block_id: "vol_behalf_new_block",
        elements: [
          {
            type: "button",
            action_id: actionIds.behalfNew,
            text: plain("+ New volunteer"),
          },
        ],
      },
    ],
  };
}

function forUserNotice(target: VolunteerTarget | null): Block[] {
  if (!target) {
    return [];
  }

  const who = hasSlackAccount(target.id)
    ? `<@${target.id}>${target.name ? ` (${escapeSlackText(target.name)})` : ""}`
    : target.name
      ? `*${escapeSlackText(target.name)}* (not on Slack)`
      : "a new volunteer who isn't on Slack";

  return [
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `📝 Entering this for ${who} on their behalf.` },
      ],
    },
  ];
}

export function buildStudentTypeView(
  mode: ProfileMode,
  existing: VolunteerProfile | null,
  forTarget: VolunteerTarget | null = null,
): ModalView {
  const options = (Object.keys(studentTypeLabels) as StudentType[]).map(
    (type) => ({ text: plain(studentTypeLabels[type]), value: type }),
  );
  const initial = options.find(
    (option) => option.value === existing?.studentType,
  );
  const metadata: ProfileTypeMetadata = {
    mode,
    existing,
    ...targetMetadata(forTarget),
  };

  return {
    type: "modal",
    callback_id: callbackIds.profileType,
    private_metadata: JSON.stringify(metadata),
    title: plain("Volunteer profile"),
    submit: plain("Next"),
    close: plain("Cancel"),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: forTarget
            ? "Enter this volunteer's details once, then you can log their hours. The same details are required as for any volunteer."
            : mode === "onboard"
              ? "Welcome! Let's set up your volunteer profile once. After this you only need to enter your hours."
              : "Update your volunteer profile.",
        },
      },
      ...forUserNotice(forTarget),
      {
        type: "input",
        block_id: blockIds.studentType,
        label: plain(forTarget ? "Which describes them?" : "Which describes you?"),
        element: {
          type: "radio_buttons",
          action_id: "student_type",
          options,
          ...(initial ? { initial_option: initial } : {}),
        },
      },
    ],
  };
}

const emailLabels: Record<StudentType, string> = {
  uoft: "UofT email",
  other_university: "University email",
  high_school: "Email",
};

const studentNumberLabels: Record<StudentType, string> = {
  uoft: "Student number",
  other_university: "University student ID / number",
  high_school: "Student number",
};

function textField(
  blockId: string,
  actionId: string,
  label: string,
  maxLength: number,
  initialValue?: string | null,
  hint?: string,
): Block {
  return {
    type: "input",
    block_id: blockId,
    label: plain(label),
    ...(hint ? { hint: plain(hint) } : {}),
    element: {
      type: "plain_text_input",
      action_id: actionId,
      max_length: maxLength,
      ...(initialValue ? { initial_value: initialValue } : {}),
    },
  };
}

/**
 * The fields mirror the MSA general volunteer sign-up form, by student type:
 * first and last name, the email asked for in that section, UTORid (UofT
 * only), and a student number or ID. The student number is how a volunteer is
 * recognised later, so it is required for every type.
 */
export function buildProfileFormView(
  mode: ProfileMode,
  studentType: StudentType,
  existing: VolunteerProfile | null,
  forTarget: VolunteerTarget | null = null,
): ModalView {
  const isUofT = studentType === "uoft";
  const prefill = existing?.studentType === studentType ? existing : null;
  const their = forTarget ? "their" : "your";
  const blocks: Block[] = [
    ...forUserNotice(forTarget),
    textField(
      blockIds.firstName,
      "first_name",
      "First name",
      60,
      existing?.firstName,
      isUofT ? `Enter ${their} name exactly as it appears on ACORN.` : undefined,
    ),
    textField(blockIds.lastName, "last_name", "Last name", 60, existing?.lastName),
    textField(
      blockIds.preferredEmail,
      "preferred_email",
      "Preferred email",
      120,
      existing?.preferredEmail,
      `The email ${their === "your" ? "you'd" : "they'd"} like to be contacted at.`,
    ),
    textField(
      blockIds.email,
      "email",
      emailLabels[studentType],
      120,
      existing?.email,
    ),
  ];

  if (isUofT) {
    blocks.push(
      textField(
        blockIds.utorid,
        "utorid",
        "UTORid",
        16,
        prefill?.utorid,
        `Double-check this one: it is how ${their} hours are matched.`,
      ),
    );
  }

  blocks.push(
    textField(
      blockIds.studentNumber,
      "student_number",
      studentNumberLabels[studentType],
      20,
      prefill?.studentNumber,
      `This is how ${their} volunteer record is recognised, so please double-check it.`,
    ),
  );

  return {
    type: "modal",
    callback_id: callbackIds.profileForm,
    private_metadata: JSON.stringify({
      mode,
      studentType,
      ...targetMetadata(forTarget),
    }),
    title: plain("Volunteer profile"),
    submit: plain(mode === "onboard" ? "Save & continue" : "Save"),
    close: plain("Cancel"),
    blocks,
  };
}

export function extractHoursFormValues(
  values: StateValuesLike,
  rowCount: number,
): HoursFormValues {
  const rows: HoursFormValues["rows"] = [];

  for (let index = 0; index < rowCount; index += 1) {
    rows.push({
      date: values[blockIds.date(index)]?.date?.selected_date ?? null,
      hours: values[blockIds.hours(index)]?.hours?.value?.trim() ?? "",
    });
  }

  return {
    categoryId: values[blockIds.category]?.category?.selected_option?.value ?? null,
    eventId: values[blockIds.event]?.event?.selected_option?.value ?? null,
    description: values[blockIds.description]?.description?.value ?? "",
    rows,
  };
}

export function emptyHoursFormValues(): HoursFormValues {
  return {
    categoryId: null,
    eventId: null,
    description: "",
    rows: [{ date: null, hours: "" }],
  };
}

/** Set when the hours form is editing an existing request. */
export interface EditContext {
  submissionId: string;
  /** An exec editing: the change takes effect right away, and they can delete. */
  asExec: boolean;
}

export function editContextFromMetadata(metadata: {
  editSubmissionId?: string | null | undefined;
  editAsExec?: boolean | null | undefined;
}): EditContext | null {
  return metadata.editSubmissionId
    ? {
        submissionId: metadata.editSubmissionId,
        asExec: Boolean(metadata.editAsExec),
      }
    : null;
}

/** Fills the hours form with an existing request, ready to change. */
export function valuesFromSubmission(
  submission: VolunteerSubmission,
): HoursFormValues {
  return {
    categoryId: submission.categoryId,
    eventId: submission.eventId,
    description: submission.description,
    rows: submission.entries.map((entry) => ({
      date: entry.entryDate,
      hours: String(entry.hours),
    })),
  };
}

export function buildHoursFormView(
  formData: VolunteerFormData,
  values: HoursFormValues,
  forTarget: VolunteerTarget | null = null,
  editing: EditContext | null = null,
): ModalView {
  const rowCount = Math.min(
    Math.max(values.rows.length, 1),
    MAX_ENTRIES_PER_SUBMISSION,
  );
  // A static select holds at most 100 options. If a list is longer, keep the
  // request's current choice (when editing) so it never loses its own value.
  const capped = <T extends { id: string }>(items: T[], keepId: string | null) => {
    const head = items.slice(0, 100);
    const kept = keepId ? items.find((item) => item.id === keepId) : undefined;

    return kept && !head.includes(kept) ? [...head.slice(0, 99), kept] : head;
  };
  const categoryOptions = capped(formData.categories, values.categoryId).map(
    (category) => ({
      text: plain(truncate(category.name, 75)),
      value: category.id,
    }),
  );
  const eventOptions = capped(formData.events, values.eventId).map((event) => ({
    text: plain(
      truncate(
        event.eventDate ? `${event.name} (${event.eventDate})` : event.name,
        75,
      ),
    ),
    value: event.id,
  }));
  const initialCategory = categoryOptions.find(
    (option) => option.value === values.categoryId,
  );
  const initialEvent = eventOptions.find(
    (option) => option.value === values.eventId,
  );

  const blocks: Block[] = [
    ...forUserNotice(forTarget),
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: editing
          ? editing.asExec
            ? "Fix anything below. As an admin, *your change takes effect right away* and doesn't need another approval."
            : "Fix anything below. When you save, *your request goes back to the approvers* to be reviewed again."
          : "Log hours for *one activity*. Add a row for each date you volunteered, with the hours for that date. Submitting within 48 hours of the activity helps approvers verify it.",
      },
    },
    {
      type: "input",
      block_id: blockIds.category,
      // Picking a category redraws the form (see the category handler), so the
      // Event dropdown can appear only when this category asks for one.
      dispatch_action: true,
      label: plain("Category"),
      element: {
        type: "static_select",
        action_id: actionIds.category,
        placeholder: plain("Choose a category"),
        options: categoryOptions,
        ...(initialCategory ? { initial_option: initialCategory } : {}),
      },
    },
  ];

  const pickedCategory = formData.categories.find(
    (category) => category.id === values.categoryId,
  );

  if (pickedCategory?.requiresEvent) {
    if (eventOptions.length > 0) {
      blocks.push({
        type: "input",
        block_id: blockIds.event,
        label: plain("Event"),
        element: {
          type: "static_select",
          action_id: "event",
          placeholder: plain("Choose the event you volunteered at"),
          options: eventOptions,
          ...(initialEvent ? { initial_option: initialEvent } : {}),
        },
      });
    } else {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `⚠️ *${escapeSlackText(truncate(pickedCategory.name, 60))}* needs an event, but none are set up yet. Ask an exec to add one, or pick another category.`,
          },
        ],
      });
    }
  }

  blocks.push({
    type: "input",
    block_id: blockIds.description,
    label: plain("What did you do?"),
    element: {
      type: "plain_text_input",
      action_id: "description",
      multiline: true,
      max_length: MAX_DESCRIPTION_LENGTH,
      ...(values.description ? { initial_value: values.description } : {}),
    },
  });

  for (let index = 0; index < rowCount; index += 1) {
    const row = values.rows[index];
    const optional = index > 0;

    blocks.push(
      {
        type: "input",
        block_id: blockIds.date(index),
        optional,
        label: plain(`Date ${index + 1}`),
        element: {
          type: "datepicker",
          action_id: "date",
          ...(row?.date ? { initial_date: row.date } : {}),
        },
      },
      {
        type: "input",
        block_id: blockIds.hours(index),
        optional,
        label: plain(`Hours for date ${index + 1}`),
        ...(index === 0
          ? {
              hint: plain(
                `Up to ${MAX_HOURS_PER_DAY} hours a day. Decimals are fine (e.g. 1.5).`,
              ),
            }
          : {}),
        element: {
          type: "number_input",
          action_id: "hours",
          is_decimal_allowed: true,
          min_value: "0.01",
          max_value: String(MAX_HOURS_PER_DAY),
          ...(row?.hours ? { initial_value: row.hours } : {}),
        },
      },
    );
  }

  const rowButtons: types.Button[] = [];
  if (rowCount < MAX_ENTRIES_PER_SUBMISSION) {
    rowButtons.push({
      type: "button",
      action_id: actionIds.addDate,
      text: plain("+ Add another date"),
    });
  }
  if (rowCount > 1) {
    rowButtons.push({
      type: "button",
      action_id: actionIds.removeDate,
      text: plain("Remove last date"),
    });
  }
  if (rowButtons.length > 0) {
    blocks.push({
      type: "actions",
      block_id: blockIds.rowActions,
      elements: rowButtons,
    });
  }

  if (editing?.asExec) {
    blocks.push({
      type: "input",
      block_id: blockIds.deleteRequest,
      optional: true,
      label: plain("Delete"),
      element: {
        type: "checkboxes",
        action_id: "delete",
        options: [
          {
            text: plain("Delete this whole request instead"),
            description: plain("For example, hours entered for the wrong person. A record of it is kept."),
            value: "delete",
          },
        ],
      },
    });
  }

  return {
    type: "modal",
    callback_id: callbackIds.hoursForm,
    private_metadata: JSON.stringify({
      rowCount,
      ...targetMetadata(forTarget),
      editSubmissionId: editing?.submissionId ?? null,
      editAsExec: editing?.asExec ?? false,
    }),
    title: plain(
      editing
        ? "Edit hours"
        : forTarget
          ? "Log hours for someone"
          : "Log hours",
    ),
    submit: plain(editing ? "Save changes" : "Submit"),
    close: plain("Cancel"),
    blocks,
  };
}

/**
 * The value an Approve or Disapprove button carries: the request and the
 * version of it the card showed. If the request is edited afterwards, a click on
 * the old card no longer matches and is refused.
 */
export function decisionValue(submission: VolunteerSubmission): string {
  return `${submission.id}:${submission.version}`;
}

export function parseDecisionValue(value: string): {
  submissionId: string;
  version: number | null;
} {
  const separator = value.lastIndexOf(":");
  const version = separator >= 0 ? Number(value.slice(separator + 1)) : NaN;

  return Number.isInteger(version) && version >= 0
    ? { submissionId: value.slice(0, separator), version }
    : { submissionId: value, version: null };
}

export function buildRejectReasonView(
  submissionId: string,
  version: number | null = null,
  /** Set when opened from the approvers' queue: the home that queue belongs to. */
  queueHome: "exec" | "admin" | null = null,
): ModalView {
  return {
    type: "modal",
    callback_id: callbackIds.rejectReason,
    private_metadata: JSON.stringify({
      submissionId,
      version,
      ...(queueHome ? { queue: queueHome } : {}),
    }),
    title: plain("Disapprove hours"),
    submit: plain("Disapprove"),
    close: plain("Cancel"),
    blocks: [
      {
        type: "input",
        block_id: blockIds.reason,
        label: plain("Reason"),
        hint: plain("The volunteer will see this so they can fix the request."),
        element: {
          type: "plain_text_input",
          action_id: "reason",
          multiline: true,
          max_length: 500,
        },
      },
    ],
  };
}

function entryLines(submission: VolunteerSubmission): string {
  return submission.entries
    .map(
      (entry) =>
        `${entry.entryDate}   ${formatHours(entry.hours)} h`,
    )
    .join("\n");
}

export function totalHours(submission: VolunteerSubmission): number {
  return Number(
    submission.entries
      .reduce((sum, entry) => sum + entry.hours, 0)
      .toFixed(2),
  );
}

function lateNote(submission: VolunteerSubmission): string {
  const lastDate = submission.entries.at(-1)?.entryDate;

  if (!lastDate) {
    return "";
  }

  const submittedDate = todayInToronto(parsePgTimestamp(submission.submittedAt));
  const days = daysBetween(lastDate, submittedDate);

  return days > 2 ? ` (${days} days after the last date)` : "";
}

export function isOnBehalf(submission: VolunteerSubmission): boolean {
  return submission.submittedBySlackUserId !== submission.volunteerSlackUserId;
}

/** The day a request was submitted, in Toronto time, as "Nov 12, 2026". */
export function submittedDate(submission: VolunteerSubmission): string {
  return formatDate(todayInToronto(parsePgTimestamp(submission.submittedAt)));
}

function submittedByLine(submission: VolunteerSubmission): string {
  const submittedDate = todayInToronto(parsePgTimestamp(submission.submittedAt));
  const base = isOnBehalf(submission)
    ? `📝 Entered by <@${submission.submittedBySlackUserId}> on the volunteer's behalf on ${submittedDate}${lateNote(submission)}`
    : `Submitted by the volunteer on ${submittedDate}${lateNote(submission)}`;

  if (!submission.editedBySlackUserId || !submission.editedAt) {
    return base;
  }

  const editedDate = todayInToronto(parsePgTimestamp(submission.editedAt));

  return `${base}\n✏️ Edited by <@${submission.editedBySlackUserId}> on ${editedDate}`;
}

export interface ApprovalCard {
  text: string;
  blocks: Block[];
}

export function buildApprovalCard(
  submission: VolunteerSubmission,
  primaryApproverId: string | null,
): ApprovalCard {
  const category = submission.eventName
    ? `${submission.categoryName}: ${submission.eventName}`
    : submission.categoryName;
  const total = formatHours(totalHours(submission));
  const isPending = submission.status === "pending";

  const blocks: Block[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*Volunteer hours request*` +
          (isPending && primaryApproverId ? `\ncc <@${primaryApproverId}>` : ""),
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Volunteer*\n${escapeSlackText(submission.volunteerName)} (${studentTypeLabels[submission.studentType]})\n${hasSlackAccount(submission.volunteerSlackUserId) ? `<@${submission.volunteerSlackUserId}>` : "_No Slack account_"}`,
        },
        {
          type: "mrkdwn",
          text: `*Category*\n${escapeSlackText(category)}`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*What they did*\n${escapeSlackText(truncate(submission.description, 2500))}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Dates and hours*\n\`\`\`${entryLines(submission)}\`\`\`\n*Total:* ${total} h`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: submittedByLine(submission),
        },
      ],
    },
  ];

  if (isPending) {
    blocks.push({
      type: "actions",
      block_id: blockIds.decisionActions,
      elements: [
        {
          type: "button",
          action_id: actionIds.approve,
          style: "primary",
          text: plain("Approve"),
          value: decisionValue(submission),
        },
        {
          type: "button",
          action_id: actionIds.disapprove,
          style: "danger",
          text: plain("Disapprove"),
          value: decisionValue(submission),
        },
      ],
    });
  } else {
    const decidedDate = submission.decidedAt
      ? todayInToronto(parsePgTimestamp(submission.decidedAt))
      : "";
    const decidedBy = submission.decidedBySlackUserId
      ? `<@${submission.decidedBySlackUserId}>`
      : "someone";
    const line =
      submission.status === "approved"
        ? `✅ Approved by ${decidedBy} on ${decidedDate}`
        : `❌ Disapproved by ${decidedBy} on ${decidedDate}: ${escapeSlackText(
            submission.decisionNote ?? "",
          )}`;

    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: line }],
    });
  }

  return {
    text: `Volunteer hours request from ${submission.volunteerName}: ${total} h`,
    blocks,
  };
}

export function submissionReceivedText(
  submission: VolunteerSubmission,
): string {
  return `✅ Got it! Your ${formatHours(totalHours(submission))} h across ${submission.entries.length} date(s) are pending approval. I'll message you when they're reviewed. You can check status any time in /volunteer → My hours.`;
}

export function submissionOnBehalfForVolunteerText(
  submission: VolunteerSubmission,
): string {
  return `✅ <@${submission.submittedBySlackUserId}> logged and approved ${formatHours(totalHours(submission))} h across ${submission.entries.length} date(s) for you. You can see them any time in /volunteer → My hours, and fix your details under My profile.`;
}

/** How to refer to the volunteer in a message to someone else. */
export function volunteerReference(submission: VolunteerSubmission): string {
  return hasSlackAccount(submission.volunteerSlackUserId)
    ? `<@${submission.volunteerSlackUserId}> (${escapeSlackText(submission.volunteerName)})`
    : `*${escapeSlackText(submission.volunteerName)}* (no Slack account)`;
}

export function submissionOnBehalfForSubmitterText(
  submission: VolunteerSubmission,
): string {
  return `✅ Logged and approved ${formatHours(totalHours(submission))} h across ${submission.entries.length} date(s) for ${volunteerReference(submission)}.`;
}

export function approvedText(submission: VolunteerSubmission): string {
  return `✅ Your volunteer hours were approved: ${formatHours(totalHours(submission))} h for ${escapeSlackText(submission.categoryName)} (${submission.entries.map((entry) => entry.entryDate).join(", ")}). Thank you!`;
}

export function rejectedText(submission: VolunteerSubmission): string {
  return `❌ Your volunteer hours (${formatHours(totalHours(submission))} h, ${submission.entries.map((entry) => entry.entryDate).join(", ")}) weren't approved.\n*Reason:* ${escapeSlackText(submission.decisionNote ?? "No reason given.")}\nYou can fix it in /volunteer → My hours (use "Fix a request") and it will go back to the approvers.`;
}

export function editSavedText(
  submission: VolunteerSubmission,
  needsApproval: boolean,
): string {
  return needsApproval
    ? `✅ Saved: ${formatHours(totalHours(submission))} h across ${submission.entries.length} date(s). Your changes went back to the approvers, and I'll message you when they're reviewed.`
    : `✅ Saved and approved: ${formatHours(totalHours(submission))} h across ${submission.entries.length} date(s).`;
}

export function editedForVolunteerText(
  submission: VolunteerSubmission,
  editorSlackUserId: string,
): string {
  return `✏️ <@${editorSlackUserId}> corrected your volunteer hours. They're now ${formatHours(totalHours(submission))} h across ${submission.entries.length} date(s) (${submission.entries.map((entry) => entry.entryDate).join(", ")}) and approved. See /volunteer → My hours.`;
}

export function deletedForVolunteerText(
  submission: VolunteerSubmission,
  deletedBySlackUserId: string,
): string {
  return `🗑️ <@${deletedBySlackUserId}> removed a volunteer hours request of yours (${formatHours(totalHours(submission))} h, ${submission.entries.map((entry) => entry.entryDate).join(", ")}). If that looks wrong, ask an admin.`;
}

/** What the approval card becomes once its request is deleted. */
export function buildDeletedCard(
  submission: VolunteerSubmission,
  deletedBySlackUserId: string,
): ApprovalCard {
  return {
    text: `Volunteer hours request from ${submission.volunteerName} was deleted`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🗑️ *Deleted by <@${deletedBySlackUserId}>*\n${escapeSlackText(submission.volunteerName)}: ${formatHours(totalHours(submission))} h (${submission.entries.map((entry) => entry.entryDate).join(", ")}). A record of the change is kept.`,
        },
      },
    ],
  };
}

export function buildRecordsPickView(): ModalView {
  return {
    type: "modal",
    callback_id: callbackIds.recordsPick,
    title: plain("Volunteer requests"),
    submit: plain("Next"),
    close: plain("Cancel"),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Look up a volunteer's requests to fix or delete one. As an admin, your changes are approved right away, and a record of each change is kept.",
        },
      },
      {
        type: "input",
        block_id: blockIds.recordsVolunteer,
        label: plain("Volunteer"),
        element: {
          type: "external_select",
          action_id: actionIds.searchVolunteer,
          placeholder: plain("Start typing a name or student number"),
          min_query_length: 1,
        },
      },
    ],
  };
}
