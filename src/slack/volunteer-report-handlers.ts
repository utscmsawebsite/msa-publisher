import type {
  ReportFilters,
  ReportSort,
  StudentTypeFilter,
} from "../domain/volunteer-report.js";
import type { VolunteerYear } from "../domain/volunteer.js";
import {
  logError,
  logInfo,
  logWarning,
} from "../logging/application-logger.js";
import type {
  GeneratedReport,
  VolunteerReportService,
} from "../services/volunteer-report.service.js";
import { todayInToronto } from "../services/volunteer.service.js";
import type { SlackClient, VolunteerSlackContext } from "./volunteer-context.js";
import { withBack, type HubBack } from "./volunteer-hub-views.js";
import {
  buildMessageView,
  escapeSlackText,
  formatHours,
  parseJsonMetadata,
  volunteerOption,
  type Block,
  type ModalView,
  type StateValuesLike,
} from "./volunteer-views.js";

const REPORT_CALLBACK = "vol_report_form";
const MARK_SENT_ACTION = "vol_mark_sent";
const SEARCH_ACTION = "vol_r_search_volunteers";

const BLOCK = {
  year: "vol_r_year",
  students: "vol_r_students",
  include: "vol_r_include",
  sort: "vol_r_sort",
  volunteers: "vol_r_volunteers",
} as const;

const studentFilters: readonly StudentTypeFilter[] = [
  "uoft",
  "all",
  "other_university",
  "high_school",
];

function plain(text: string): { type: "plain_text"; text: string } {
  return { type: "plain_text", text };
}

function option(text: string, value: string) {
  return { text: plain(text), value };
}

/** CCR report: one combined CSV + PDF. Letters: one letterhead PDF per volunteer. */
export type ReportMode = "combined" | "letterhead";

export function buildReportFormView(
  years: VolunteerYear[],
  preselectedYearId: string | null = null,
  mode: ReportMode = "combined",
): ModalView {
  const today = todayInToronto();
  const yearOptions = years
    .slice(-100)
    .map((year) => option(year.label.slice(0, 75), year.id));
  const currentYear =
    years.find((year) => year.id === preselectedYearId) ??
    years.find((year) => today >= year.startDate && today <= year.endDate) ??
    years.at(-1);
  const initialYear = yearOptions.find(
    (candidate) => candidate.value === currentYear?.id,
  );

  const studentOptions = [
    option("UofT students only (for CCR)", "uoft"),
    option("All students", "all"),
    option("Other university students only", "other_university"),
    option("High school students only", "high_school"),
  ];
  const includeOptions = [
    option("Only entries not yet sent to CCR", "unsent"),
    option("All approved entries", "all"),
  ];
  const sortOptions = [
    option("By name, then date", "name"),
    option("By date, then name", "date"),
  ];

  const yearBlock: Block = {
    type: "input",
    block_id: BLOCK.year,
    label: plain("Volunteer year"),
    element: {
      type: "static_select",
      action_id: "year",
      options: yearOptions,
      ...(initialYear ? { initial_option: initialYear } : {}),
    },
  };

  const volunteersBlock = (required: boolean): Block => ({
    type: "input",
    block_id: BLOCK.volunteers,
    ...(required ? {} : { optional: true }),
    label: plain(required ? "Volunteers" : "Only these volunteers"),
    hint: plain(
      required
        ? "Search by name, UTORid or email (volunteers without Slack included). Each letter includes all of that volunteer's approved hours in the year."
        : "Leave empty for everyone. Search by name, UTORid or email (volunteers without Slack included).",
    ),
    element: {
      type: "multi_external_select",
      action_id: SEARCH_ACTION,
      placeholder: plain("Start typing a name or UTORid"),
      min_query_length: 1,
      max_selected_items: 50,
    },
  });

  const intro = (text: string): Block => ({
    type: "section",
    text: { type: "mrkdwn", text },
  });

  const blocks: Block[] =
    mode === "letterhead"
      ? [
          intro(
            "One letter per volunteer on MSA letterhead, signed with your name and title. Only *approved* hours are included. The files are sent to you in a direct message.",
          ),
          yearBlock,
          volunteersBlock(true),
        ]
      : [
          intro(
            "A combined CSV and PDF of *approved* hours, for submitting to CCR. The files are sent to you in a direct message.",
          ),
          yearBlock,
          {
            type: "input",
            block_id: BLOCK.students,
            label: plain("Students"),
            element: {
              type: "static_select",
              action_id: "students",
              options: studentOptions,
              initial_option: studentOptions[0] ?? option("UofT", "uoft"),
            },
          },
          {
            type: "input",
            block_id: BLOCK.include,
            label: plain("Entries"),
            element: {
              type: "radio_buttons",
              action_id: "include",
              options: includeOptions,
              initial_option: includeOptions[0] ?? option("Unsent", "unsent"),
            },
          },
          {
            type: "input",
            block_id: BLOCK.sort,
            label: plain("Sort"),
            element: {
              type: "radio_buttons",
              action_id: "sort",
              options: sortOptions,
              initial_option: sortOptions[0] ?? option("Name", "name"),
            },
          },
          volunteersBlock(false),
        ];

  return {
    type: "modal",
    callback_id: REPORT_CALLBACK,
    private_metadata: JSON.stringify({ mode }),
    title: plain(mode === "letterhead" ? "Volunteer letters" : "CCR report"),
    submit: plain("Generate"),
    close: plain("Cancel"),
    blocks,
  };
}

function summaryText(report: GeneratedReport, kind: "combined" | "letterhead"): string {
  const volunteers = `${report.volunteerCount} volunteer${report.volunteerCount === 1 ? "" : "s"}`;
  const skipped =
    report.skippedVolunteers.length > 0
      ? `\nNo approved hours found for: ${report.skippedVolunteers.map(escapeSlackText).join(", ")}.`
      : "";

  return kind === "combined"
    ? `✅ Report ready: ${report.entryCount} entries, ${formatHours(report.totalHours)} h across ${volunteers}.${skipped}`
    : `✅ ${report.files.length} letter${report.files.length === 1 ? "" : "s"} ready (${formatHours(report.totalHours)} h across ${volunteers}).${skipped}`;
}

async function deliverReport(
  client: SlackClient,
  slackUserId: string,
  report: GeneratedReport,
  kind: "combined" | "letterhead",
): Promise<void> {
  const opened = await client.conversations.open({ users: slackUserId });
  const channelId = opened.channel?.id;

  if (!channelId) {
    throw new Error("conversations.open did not return a channel id.");
  }

  await client.filesUploadV2({
    channel_id: channelId,
    initial_comment: summaryText(report, kind),
    file_uploads: report.files.map((file) => ({
      file: Buffer.from(file.content),
      filename: file.filename,
    })),
  });

  if (kind !== "combined") {
    return;
  }

  const blocks: Block[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "If you're submitting these to CCR, mark them as sent so the next export with *not yet sent* skips them. Don't mark them if you're only reviewing.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: MARK_SENT_ACTION,
          style: "primary",
          text: plain(`Mark ${report.entryCount} entries as sent to CCR`),
          value: report.export.id,
          confirm: {
            title: plain("Mark as sent to CCR?"),
            text: {
              type: "mrkdwn",
              text: "Every entry in this export will be marked as sent. Exports that only include entries not yet sent will skip them from now on.",
            },
            confirm: plain("Mark as sent"),
            deny: plain("Cancel"),
          },
        },
      ],
    },
  ];

  await client.chat.postMessage({
    channel: channelId,
    text: "Mark these entries as sent to CCR?",
    blocks,
  });
}

export interface ReportFlows {
  /**
   * `home` is where the form's ← Back button leads. `yearId`, when given, is
   * the year the form starts on.
   */
  beginReport: (
    client: SlackClient,
    viewId: string,
    userId: string,
    home?: HubBack,
    yearId?: string,
    mode?: ReportMode,
  ) => Promise<void>;
  /** The letters form: the same as the report flow, in letters mode. */
  beginLetters: (
    client: SlackClient,
    viewId: string,
    userId: string,
    home?: HubBack,
  ) => Promise<void>;
}

export function registerVolunteerReportHandlers(
  context: VolunteerSlackContext,
  reports: VolunteerReportService,
): ReportFlows {
  const { app, background, opsLog, sendDirectMessage } = context;

  app.options(SEARCH_ACTION, async ({ ack, body, options }) => {
    try {
      const matches = await reports.searchVolunteers(body.user.id, options.value);

      await ack({ options: matches.map(volunteerOption) });
    } catch (error) {
      logError("volunteer_report_search_failed", error, {
        slackUserId: body.user.id,
      });
      await ack({ options: [] });
    }
  });

  /** Fills an already-open modal with the report form (or says why not). */
  const beginReport = async (
    client: SlackClient,
    viewId: string,
    userId: string,
    home?: HubBack,
    yearId?: string,
    mode: ReportMode = "combined",
  ): Promise<void> => {
    const title = mode === "letterhead" ? "Volunteer letters" : "CCR report";
    const show = (view: ModalView) =>
      client.views.update({
        view_id: viewId,
        view: home ? withBack(view, home) : view,
      });

    if (!(await reports.canUseReports(userId))) {
      await show(
        buildMessageView(
          title,
          "Only volunteer execs and admins can generate reports and letters.",
        ),
      );
      return;
    }

    const years = await reports.listYears();

    await show(
      years.length === 0
        ? buildMessageView(
            title,
            "No volunteer years exist yet. An admin can add one in /volunteer-admin first.",
          )
        : buildReportFormView(years, yearId ?? null, mode),
    );
  };

  app.view(REPORT_CALLBACK, async ({ ack, body, client, view }) => {
    const values: StateValuesLike = view.state.values;
    const yearId = values[BLOCK.year]?.year?.selected_option?.value;
    const studentsValue =
      values[BLOCK.students]?.students?.selected_option?.value ?? "uoft";
    const include = values[BLOCK.include]?.include?.selected_option?.value;
    const sortValue = values[BLOCK.sort]?.sort?.selected_option?.value;
    const mode: ReportMode =
      parseJsonMetadata<{ mode: ReportMode }>(view.private_metadata).mode ===
      "letterhead"
        ? "letterhead"
        : "combined";
    const selectedVolunteers =
      values[BLOCK.volunteers]?.[SEARCH_ACTION]?.selected_options ?? [];
    const volunteers = selectedVolunteers.flatMap((selected) =>
      selected.value ? [selected.value] : [],
    );
    // Letters list volunteers by name, so the student filter doesn't apply.
    const studentType =
      mode === "letterhead"
        ? ("all" as const)
        : studentFilters.find((candidate) => candidate === studentsValue);
    const sort: ReportSort = sortValue === "date" ? "date" : "name";
    const errors: Record<string, string> = {};

    if (!yearId) {
      errors[BLOCK.year] = "Choose a volunteer year.";
    }

    if (!studentType) {
      errors[BLOCK.students] = "Choose which students to include.";
    }

    if (mode === "letterhead" && volunteers.length === 0) {
      errors[BLOCK.volunteers] = "Pick at least one volunteer for letters.";
    }

    if (Object.keys(errors).length > 0 || !yearId || !studentType) {
      await ack({ response_action: "errors", errors });
      return;
    }

    await ack();

    const requestedBy = body.user.id;
    const kind = mode;
    const filters: ReportFilters = {
      yearId,
      studentType,
      onlyUnsent: include !== "all",
      sort,
      volunteerSlackUserIds: volunteers.length > 0 ? volunteers : null,
    };

    await background("report_generate", async () => {
      try {
        const result =
          kind === "letterhead"
            ? await reports.generateLetterheads(
                requestedBy,
                filters,
                new Map(
                  selectedVolunteers.flatMap((selected) =>
                    selected.value
                      ? [[selected.value, selected.text?.text ?? selected.value] as const]
                      : [],
                  ),
                ),
              )
            : await reports.generateCombined(requestedBy, filters);

        if (result.status === "not_authorized") {
          logWarning("volunteer_authorization_denied", {
            slackUserId: requestedBy,
            action: "volunteer_report",
          });
          await sendDirectMessage(
            client,
            requestedBy,
            "Only volunteer staff can generate reports.",
          );
          await opsLog(
            client,
            `⚠️ Unauthorized volunteer report request rejected\nUser: <@${requestedBy}>`,
          );
          return;
        }

        if (result.status === "no_year") {
          await sendDirectMessage(
            client,
            requestedBy,
            "That volunteer year no longer exists. Open /volunteer-exec and start again.",
          );
          return;
        }

        if (result.status === "no_signatory") {
          await sendDirectMessage(
            client,
            requestedBy,
            "Letters are signed with your name and title, and your staff record has no title yet. Ask a volunteer admin to add it in /volunteer-admin (Staff → Edit), then open /volunteer-exec and choose Volunteer letters again.",
          );
          return;
        }

        if (result.status === "empty") {
          await sendDirectMessage(
            client,
            requestedBy,
            "No approved entries match those filters, so no files were generated.",
          );
          return;
        }

        await deliverReport(client, requestedBy, result.report, kind);

        logInfo("volunteer_report_generated", {
          exportId: result.report.export.id,
          kind,
          entryCount: result.report.entryCount,
          generatedBySlackUserId: requestedBy,
        });
        await opsLog(
          client,
          `📄 Volunteer report generated by <@${requestedBy}>\nType: ${kind}\nEntries: ${result.report.entryCount} (${formatHours(result.report.totalHours)} h)`,
        );
      } catch (error) {
        logError("volunteer_report_failed", error, {
          generatedBySlackUserId: requestedBy,
        });
        await sendDirectMessage(
          client,
          requestedBy,
          "Sorry, the report could not be generated. Please try again.",
        );
      }
    });
  });

  app.action(MARK_SENT_ACTION, async ({ ack, action, body, client }) => {
    await ack();
    const exportId = "value" in action ? action.value : undefined;
    const channelId = body.channel?.id;
    const messageTs = "message" in body ? body.message?.ts : undefined;

    if (!exportId) {
      return;
    }

    await background("report_mark_sent", async () => {
      const outcome = await reports.markSent(exportId, body.user.id);
      let text: string;

      if (outcome.status === "not_authorized") {
        logWarning("volunteer_authorization_denied", {
          slackUserId: body.user.id,
          action: "volunteer_mark_sent",
        });
        text = "You don't have permission to mark entries as sent.";
      } else if (outcome.result.status === "ok") {
        logInfo("volunteer_export_marked_sent", {
          exportId,
          markedEntries: outcome.result.markedEntries,
          markedBySlackUserId: body.user.id,
        });
        text = `✅ Marked ${outcome.result.markedEntries} entries as sent to CCR by <@${body.user.id}> on ${todayInToronto()}.`;
      } else if (outcome.result.status === "already_marked") {
        text = "This export was already marked as sent.";
      } else {
        text = "That export no longer exists.";
      }

      if (channelId && messageTs) {
        await client.chat.update({
          channel: channelId,
          ts: messageTs,
          text,
          blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
        });
      } else {
        await sendDirectMessage(client, body.user.id, text);
      }
    });
  });

  const beginLetters = (
    client: SlackClient,
    viewId: string,
    userId: string,
    home?: HubBack,
  ): Promise<void> =>
    beginReport(client, viewId, userId, home, undefined, "letterhead");

  return { beginReport, beginLetters };
}
