import { App } from "@slack/bolt";
import type { Receiver } from "@slack/bolt";
import {
  hasSlackAccount,
  studentTypeLabels,
  type PreparedSubmission,
  type ProfileIssue,
  type StudentType,
  type SubmissionIssue,
  type VolunteerSubmission,
} from "../domain/volunteer.js";
import {
  logError,
  logInfo,
  logWarning,
} from "../logging/application-logger.js";
import type { VolunteerServices } from "../volunteer-application.js";
import type {
  DecisionResult,
  ProfileFormInput,
} from "../services/volunteer.service.js";
import { MAX_ENTRIES_PER_SUBMISSION } from "../services/volunteer.service.js";
import {
  ACK_BUDGET_MS,
  settleWithin,
  type SlackClient,
} from "./volunteer-context.js";
import { registerVolunteerAdminHandlers } from "./volunteer-admin-handlers.js";
import { registerVolunteerHubs } from "./volunteer-hubs.js";
import {
  buildDoneView,
  hubActionIds,
  parseHubBack,
  withBack,
  type DoneAction,
  type HubBack,
  type HubHome,
} from "./volunteer-hub-views.js";
import {
  buildRequestsView,
  parseRequestEditValue,
  requestTotals,
} from "./volunteer-request-views.js";
import { buildPendingView } from "./volunteer-pending-views.js";
import { registerVolunteerReportHandlers } from "./volunteer-report-handlers.js";
import {
  actionIds,
  approvedText,
  blockIds,
  buildApprovalCard,
  buildBehalfPickView,
  buildDeletedCard,
  buildHoursFormView,
  buildLoadingView,
  buildMessageView,
  buildProfileFormView,
  buildRecordsPickView,
  buildRejectReasonView,
  buildStudentTypeView,
  callbackIds,
  deletedForVolunteerText,
  editContextFromMetadata,
  editedForVolunteerText,
  editSavedText,
  emptyHoursFormValues,
  escapeSlackText,
  formatHours,
  extractHoursFormValues,
  parseDecisionValue,
  parseJsonMetadata,
  rejectedText,
  submissionOnBehalfForSubmitterText,
  submissionOnBehalfForVolunteerText,
  submissionReceivedText,
  targetFromMetadata,
  totalHours,
  valuesFromSubmission,
  volunteerOption,
  volunteerReference,
  type ModalView,
  type ProfileMode,
  type ProfileTypeMetadata,
  type StateValuesLike,
  type VolunteerTarget,
} from "./volunteer-views.js";

export interface VolunteerSlackAppOptions {
  receiver?: Receiver;
  scheduleBackgroundTask?: (task: Promise<unknown>) => void;
}

/** The ack for a view submission, which is all these handlers ever receive. */
type ViewSubmissionAck = (
  response:
    | { response_action: "update"; view: ModalView }
    | { response_action: "errors"; errors: Record<string, string> },
) => Promise<void>;

function isStudentType(value: unknown): value is StudentType {
  return typeof value === "string" && value in studentTypeLabels;
}

function profileErrors(issues: ProfileIssue[]): Record<string, string> {
  const blockByField: Record<ProfileIssue["field"], string> = {
    studentType: blockIds.studentType,
    firstName: blockIds.firstName,
    lastName: blockIds.lastName,
    preferredEmail: blockIds.preferredEmail,
    email: blockIds.email,
    utorid: blockIds.utorid,
    studentNumber: blockIds.studentNumber,
  };
  const errors: Record<string, string> = {};

  for (const issue of issues) {
    errors[blockByField[issue.field]] ??= issue.message;
  }

  return errors;
}

function submissionErrors(
  issues: SubmissionIssue[],
  rowIndexes: number[],
): Record<string, string> {
  const errors: Record<string, string> = {};

  for (const issue of issues) {
    if (issue.target === "entry") {
      const row = rowIndexes[issue.index] ?? 0;
      const block =
        issue.field === "date" ? blockIds.date(row) : blockIds.hours(row);
      errors[block] ??= issue.message;
      continue;
    }

    const block =
      issue.target === "event"
        ? blockIds.event
        : issue.target === "description"
          ? blockIds.description
          : blockIds.category;
    errors[block] ??= issue.message;
  }

  return errors;
}

function issueSummary(issues: SubmissionIssue[]): string {
  return issues.map((issue) => `• ${escapeSlackText(issue.message)}`).join("\n");
}

export function createVolunteerSlackApp(
  services: VolunteerServices,
  options: VolunteerSlackAppOptions = {},
): App {
  const volunteerService = services.volunteer;
  const botToken = process.env.SLACK_VOLUNTEER_BOT_TOKEN?.trim();
  const approvalsChannelId =
    process.env.SLACK_VOLUNTEER_APPROVALS_CHANNEL_ID?.trim();
  const logChannelId = process.env.SLACK_VOLUNTEER_LOG_CHANNEL_ID?.trim();

  if (!botToken) {
    throw new Error(
      "SLACK_VOLUNTEER_BOT_TOKEN must be defined in the environment variables.",
    );
  }

  if (!approvalsChannelId) {
    throw new Error(
      "SLACK_VOLUNTEER_APPROVALS_CHANNEL_ID must be defined in the environment variables.",
    );
  }

  let app: App;

  if (options.receiver) {
    app = new App({
      token: botToken,
      receiver: options.receiver,
      tokenVerificationEnabled: false,
    });
  } else {
    const appToken = process.env.SLACK_VOLUNTEER_APP_TOKEN?.trim();

    if (!appToken) {
      throw new Error(
        "SLACK_VOLUNTEER_APP_TOKEN must be defined when using Socket Mode.",
      );
    }

    app = new App({ token: botToken, appToken, socketMode: true });
  }

  const background = async (
    name: string,
    task: () => Promise<void>,
  ): Promise<void> => {
    const promise = task().catch((error: unknown) => {
      logError(`volunteer_${name}_failed`, error);
    });

    if (options.scheduleBackgroundTask) {
      options.scheduleBackgroundTask(promise);
      return;
    }

    await promise;
  };

  const opsLog = async (client: SlackClient, text: string): Promise<void> => {
    if (!logChannelId) {
      return;
    }

    try {
      await client.chat.postMessage({ channel: logChannelId, text });
    } catch (error) {
      logError("volunteer_log_delivery_failed", error);
    }
  };

  const sendDirectMessage = async (
    client: SlackClient,
    slackUserId: string,
    text: string,
  ): Promise<boolean> => {
    try {
      await client.chat.postMessage({ channel: slackUserId, text });
      return true;
    } catch (error) {
      logError("volunteer_dm_failed", error, { slackUserId });
      return false;
    }
  };

  const notifyActorDefault = async (
    client: SlackClient,
    slackUserId: string,
    channelId: string | null,
    text: string,
  ): Promise<void> => {
    if (channelId) {
      try {
        await client.chat.postEphemeral({
          channel: channelId,
          user: slackUserId,
          text,
        });
        return;
      } catch (error) {
        logWarning("volunteer_ephemeral_failed", {
          slackUserId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await sendDirectMessage(client, slackUserId, text);
  };

  const refreshCard = async (
    client: SlackClient,
    submissionId: string,
  ): Promise<void> => {
    const submission = await volunteerService.getSubmission(submissionId);

    if (!submission?.approvalChannelId || !submission.approvalMessageTs) {
      return;
    }

    const primary = await volunteerService.getPrimaryApprover();
    const card = buildApprovalCard(submission, primary?.slackUserId ?? null);

    await client.chat.update({
      channel: submission.approvalChannelId,
      ts: submission.approvalMessageTs,
      text: card.text,
      blocks: card.blocks,
    });
  };

  const handleDecision = async (
    client: SlackClient,
    result: DecisionResult,
    actorId: string,
    submissionId: string,
    channelId: string | null,
    /** How to tell the person who clicked; by default an ephemeral message or DM. */
    tellActor?: (text: string) => Promise<void>,
  ): Promise<void> => {
    const notifyActor = async (
      notifyClient: SlackClient,
      slackUserId: string,
      notifyChannelId: string | null,
      text: string,
    ): Promise<void> =>
      tellActor
        ? tellActor(text)
        : notifyActorDefault(notifyClient, slackUserId, notifyChannelId, text);

    if (result.status === "not_authorized") {
      logWarning("volunteer_authorization_denied", {
        slackUserId: actorId,
        submissionId,
      });
      await notifyActor(
        client,
        actorId,
        channelId,
        "You don't have permission to approve volunteer hours.",
      );
      await opsLog(
        client,
        `⚠️ Unauthorized volunteer-hours decision rejected\nUser: <@${actorId}>\nSubmission ID: ${submissionId}`,
      );
      return;
    }

    if (result.status === "not_found") {
      await notifyActor(
        client,
        actorId,
        channelId,
        "That request no longer exists.",
      );
      return;
    }

    if (result.status === "stale") {
      await notifyActor(
        client,
        actorId,
        channelId,
        "That request was just edited, so your click was ignored. Please review the updated card and decide again.",
      );
      await refreshCard(client, submissionId).catch((error: unknown) =>
        logError("volunteer_card_refresh_failed", error, { submissionId }),
      );
      return;
    }

    if (result.status === "note_required") {
      await notifyActor(
        client,
        actorId,
        channelId,
        "A reason is required to disapprove hours.",
      );
      return;
    }

    if (result.status === "already_decided") {
      const decider = result.submission.decidedBySlackUserId;
      await notifyActor(
        client,
        actorId,
        channelId,
        `That request was already ${result.submission.status === "approved" ? "approved" : "disapproved"}${decider ? ` by <@${decider}>` : ""}.`,
      );
      await refreshCard(client, submissionId).catch((error: unknown) =>
        logError("volunteer_card_refresh_failed", error, { submissionId }),
      );
      return;
    }

    const { submission } = result;
    logInfo("volunteer_hours_decided", {
      submissionId,
      status: submission.status,
      decidedBySlackUserId: actorId,
      volunteerSlackUserId: submission.volunteerSlackUserId,
    });

    try {
      await refreshCard(client, submissionId);
    } catch (error) {
      logError("volunteer_card_update_failed", error, { submissionId });
      await opsLog(
        client,
        `⚠️ Couldn't update the approval card for submission ${submissionId}. The decision was saved.`,
      );
    }

    // A volunteer an exec entered hours for may not have Slack at all.
    const dmSent =
      !hasSlackAccount(submission.volunteerSlackUserId) ||
      (await sendDirectMessage(
        client,
        submission.volunteerSlackUserId,
        submission.status === "approved"
          ? approvedText(submission)
          : rejectedText(submission),
      ));

    if (!dmSent) {
      await opsLog(
        client,
        `⚠️ Couldn't DM <@${submission.volunteerSlackUserId}> about their ${submission.status} hours. The decision was saved.`,
      );
    }
  };

  const postApprovalCard = async (
    client: SlackClient,
    submission: VolunteerSubmission,
  ): Promise<boolean> => {
    try {
      const primary = await volunteerService.getPrimaryApprover();
      const card = buildApprovalCard(submission, primary?.slackUserId ?? null);
      const posted = await client.chat.postMessage({
        channel: approvalsChannelId,
        text: card.text,
        blocks: card.blocks,
      });

      if (posted.ts && posted.channel) {
        await volunteerService.recordApprovalMessage(
          submission.id,
          posted.channel,
          posted.ts,
        );
      }

      return true;
    } catch (error) {
      logError("volunteer_approval_card_failed", error, {
        submissionId: submission.id,
      });
      return false;
    }
  };

  const editFailureText = {
    not_found: "That request no longer exists.",
    not_allowed: "You can't change that request.",
    locked:
      "Some of those hours were already sent to CCR, so this request can't be changed any more. Ask an admin to log a correction instead.",
  } as const;

  /** Applies a prepared edit and tells everyone who needs to know. */
  const finishEdit = async (
    client: SlackClient,
    editorId: string,
    prepared: PreparedSubmission,
    tell: (text: string) => Promise<void>,
  ): Promise<void> => {
    const outcome = await volunteerService.applyEdit(prepared, editorId);

    if (outcome.status === "unchanged") {
      await tell("Nothing was different, so nothing was changed.");
      return;
    }

    if (outcome.status !== "ok") {
      if (outcome.status === "not_allowed") {
        logWarning("volunteer_authorization_denied", {
          slackUserId: editorId,
          action: "edit_request",
          submissionId: prepared.id,
        });
      }

      await tell(`⚠️ ${editFailureText[outcome.status]}`);
      return;
    }

    const { submission, needsApproval } = outcome;
    logInfo("volunteer_hours_edited", {
      submissionId: submission.id,
      volunteerSlackUserId: submission.volunteerSlackUserId,
      editedBySlackUserId: editorId,
      needsApproval,
    });

    const hadCard = Boolean(
      submission.approvalChannelId && submission.approvalMessageTs,
    );
    let cardOk: boolean;

    if (hadCard) {
      try {
        await refreshCard(client, submission.id);
        cardOk = true;
      } catch (error) {
        logError("volunteer_card_update_failed", error, {
          submissionId: submission.id,
        });
        cardOk = false;
      }
    } else {
      cardOk = await postApprovalCard(client, submission);
    }

    if (!cardOk) {
      await opsLog(
        client,
        `⚠️ Edited hours were saved but their approval card couldn't be updated.\nSubmission ID: ${submission.id}`,
      );
    } else if (
      needsApproval &&
      hadCard &&
      submission.approvalChannelId &&
      submission.approvalMessageTs
    ) {
      // An edit doesn't notify anyone, so nudge the approvers in the card's thread.
      try {
        const primary = await volunteerService.getPrimaryApprover();

        await client.chat.postMessage({
          channel: submission.approvalChannelId,
          thread_ts: submission.approvalMessageTs,
          text: `${primary ? `cc <@${primary.slackUserId}> ` : ""}✏️ <@${editorId}> edited this request, so it needs another review.`,
        });
      } catch (error) {
        logError("volunteer_edit_nudge_failed", error, {
          submissionId: submission.id,
        });
      }
    }

    await tell(editSavedText(submission, needsApproval));

    if (editorId !== submission.volunteerSlackUserId) {
      if (hasSlackAccount(submission.volunteerSlackUserId)) {
        await sendDirectMessage(
          client,
          submission.volunteerSlackUserId,
          editedForVolunteerText(submission, editorId),
        );
      }

      await opsLog(
        client,
        `✏️ <@${editorId}> corrected hours for ${volunteerReference(submission)}\nSubmission ID: ${submission.id}`,
      );
    }
  };

  /** Deletes a request (execs only) and tells everyone who needs to know. */
  const finishDelete = async (
    client: SlackClient,
    actorId: string,
    submissionId: string,
    tell: (text: string) => Promise<void>,
  ): Promise<void> => {
    const outcome = await volunteerService.deleteRequest(actorId, submissionId);

    if (outcome.status !== "ok") {
      if (outcome.status === "not_allowed") {
        logWarning("volunteer_authorization_denied", {
          slackUserId: actorId,
          action: "delete_request",
          submissionId,
        });
        await opsLog(
          client,
          `⚠️ Unauthorized request deletion rejected\nUser: <@${actorId}>\nSubmission ID: ${submissionId}`,
        );
      }

      await tell(
        `⚠️ ${
          outcome.status === "not_allowed"
            ? "Only volunteer admins can delete a request."
            : editFailureText[outcome.status]
        }`,
      );
      return;
    }

    const { submission } = outcome;
    logInfo("volunteer_hours_deleted", {
      submissionId,
      volunteerSlackUserId: submission.volunteerSlackUserId,
      deletedBySlackUserId: actorId,
    });

    if (submission.approvalChannelId && submission.approvalMessageTs) {
      try {
        const card = buildDeletedCard(submission, actorId);

        await client.chat.update({
          channel: submission.approvalChannelId,
          ts: submission.approvalMessageTs,
          text: card.text,
          blocks: card.blocks,
        });
      } catch (error) {
        logError("volunteer_card_update_failed", error, { submissionId });
      }
    }

    await tell(
      `🗑️ Deleted the request for ${volunteerReference(submission)}. A record of it is kept.`,
    );

    if (
      actorId !== submission.volunteerSlackUserId &&
      hasSlackAccount(submission.volunteerSlackUserId)
    ) {
      await sendDirectMessage(
        client,
        submission.volunteerSlackUserId,
        deletedForVolunteerText(submission, actorId),
      );
    }

    await opsLog(
      client,
      `🗑️ <@${actorId}> deleted a request for ${volunteerReference(submission)}\nSubmission ID: ${submissionId}`,
    );
  };

  /** The edit form for a request, or a message if it can't be edited. */
  const resolveEditView = async (
    actorId: string,
    submissionId: string,
  ): Promise<ModalView> => {
    const access = await volunteerService.getRequestForEdit(
      actorId,
      submissionId,
    );

    if (access.status !== "ok") {
      if (access.status === "not_allowed") {
        logWarning("volunteer_authorization_denied", {
          slackUserId: actorId,
          action: "edit_request",
          submissionId,
        });
      }

      return buildMessageView(
        "Edit hours",
        access.status === "not_allowed"
          ? "You can only change your own requests."
          : editFailureText[access.status],
      );
    }

    const { submission, asExec } = access;
    const formData = await volunteerService.getFormData();
    // A request keeps its own category and event even if an exec has since
    // deactivated them, so fixing the hours never forces a change.
    const categories = formData.categories.some(
      (category) => category.id === submission.categoryId,
    )
      ? formData.categories
      : [
          ...formData.categories,
          {
            id: submission.categoryId,
            name: submission.categoryName,
            requiresEvent: submission.eventId !== null,
            isActive: false,
            sortOrder: 999,
          },
        ];
    const events =
      submission.eventId &&
      !formData.events.some((event) => event.id === submission.eventId)
        ? [
            ...formData.events,
            {
              id: submission.eventId,
              name: submission.eventName ?? "Event",
              eventDate: null,
              isActive: false,
            },
          ]
        : formData.events;

    return buildHoursFormView(
      { ...formData, categories, events },
      valuesFromSubmission(submission),
      submission.volunteerSlackUserId === actorId
        ? null
        : { id: submission.volunteerSlackUserId, name: submission.volunteerName },
      { submissionId: submission.id, asExec },
    );
  };

  /**
   * Moves a modal on to its next step. The next view needs database work, so
   * if that is slow it shows a loading view first and swaps it in afterwards,
   * keeping inside Slack's three second limit.
   */
  const chainView = async (options: {
    ack: ViewSubmissionAck;
    client: SlackClient;
    viewId: string;
    actorId: string;
    attempt: Promise<ModalView>;
    title: string;
    errorBlockId: string;
    logName: string;
  }): Promise<void> => {
    const { ack, client, viewId, actorId, attempt, title } = options;

    let first;
    try {
      first = await settleWithin(attempt, ACK_BUDGET_MS);
    } catch (error) {
      logError(options.logName, error, { slackUserId: actorId });
      await ack({
        response_action: "errors",
        errors: {
          [options.errorBlockId]: "Something went wrong. Please try again.",
        },
      });
      return;
    }

    if (first.settled) {
      await ack({ response_action: "update", view: first.value });
      return;
    }

    await ack({ response_action: "update", view: buildLoadingView(title) });

    await background(options.logName, async () => {
      let next: ModalView;
      try {
        next = await attempt;
      } catch (error) {
        logError(options.logName, error, { slackUserId: actorId });
        next = buildMessageView(title, "Something went wrong. Please start again.");
      }

      await client.views.update({ view_id: viewId, view: next });
    });
  };

  /**
   * Shows a screen in the open modal. When the screen was reached from a home
   * screen, it gets a ← Back button to that home.
   */
  const show = (
    client: SlackClient,
    viewId: string,
    view: ModalView,
    home?: HubBack,
  ) =>
    client.views.update({
      view_id: viewId,
      view: home ? withBack(view, home) : view,
    });

  /**
   * How a saved form tells the person what happened: it replaces the form with
   * a "done" screen and next-step buttons. If that screen can't be shown (the
   * window was closed), the message goes to them as a DM instead. Only the
   * first message becomes the screen; any later one is sent as a DM.
   */
  const makeFeedback = (
    client: SlackClient,
    viewId: string,
    actorId: string,
    doneTitle: string,
    actions: DoneAction[],
  ): ((text: string) => Promise<void>) => {
    let shown = false;

    return async (text: string): Promise<void> => {
      if (!shown) {
        shown = true;

        try {
          await client.views.update({
            view_id: viewId,
            view: buildDoneView({ title: doneTitle, body: text, actions }),
          });
          return;
        } catch {
          // The window was closed: fall through to a DM.
        }
      }

      await sendDirectMessage(client, actorId, text);
    };
  };

  /** What to offer next once a form has been saved, by what it was for. */
  const doneActionsFor = (context: {
    editing: boolean;
    onBehalf: boolean;
    origin: HubBack | null;
  }): DoneAction[] => {
    if (context.editing) {
      const origin =
        context.origin && context.origin !== "behalf" ? context.origin : "my";

      return origin.startsWith("records:")
        ? [
            {
              label: "Back to their requests",
              actionId: hubActionIds.back,
              value: origin,
              primary: true,
            },
            { label: "Admin home", actionId: hubActionIds.back, value: "admin" },
          ]
        : [
            {
              label: "Back to My hours",
              actionId: hubActionIds.back,
              value: "my",
              primary: true,
            },
          ];
    }

    return context.onBehalf
      ? [
          {
            label: "Log hours for someone else",
            actionId: hubActionIds.hoursFor,
            value: "admin",
            primary: true,
          },
          { label: "Admin home", actionId: hubActionIds.back, value: "admin" },
        ]
      : [
          {
            label: "Log more hours",
            actionId: hubActionIds.hours,
            value: "member",
            primary: true,
          },
          { label: "My hours", actionId: hubActionIds.myHours, value: "member" },
        ];
  };

  /**
   * The start of each form. They fill an already-open modal (the caller opened
   * it with a loading view, so the trigger_id was used up straight away) and
   * throw if something goes wrong, so the caller can show one error message.
   */
  const beginHours = async (
    client: SlackClient,
    viewId: string,
    userId: string,
    home?: HubHome,
  ): Promise<void> => {
    const profile = await volunteerService.getProfile(userId);

    if (!profile) {
      await show(client, viewId, buildStudentTypeView("onboard", null), home);
      return;
    }

    const formData = await volunteerService.getFormData();

    if (formData.categories.length === 0 || formData.years.length === 0) {
      await show(
        client,
        viewId,
        buildMessageView(
          "Log hours",
          "Volunteer hours aren't set up yet. Please ask an admin to add a category and a volunteer year.",
        ),
        home,
      );
      return;
    }

    await show(
      client,
      viewId,
      buildHoursFormView(formData, emptyHoursFormValues()),
      home,
    );
  };

  const beginHoursFor = async (
    client: SlackClient,
    viewId: string,
    userId: string,
    home?: HubHome,
  ): Promise<void> => {
    if (!(await volunteerService.canSubmitForOthers(userId))) {
      logWarning("volunteer_authorization_denied", {
        slackUserId: userId,
        action: "hours_for_someone",
      });
      await show(
        client,
        viewId,
        buildMessageView(
          "Log hours for someone",
          "Only volunteer admins can log hours on someone else's behalf. Use /volunteer to log your own.",
        ),
        home,
      );
      await opsLog(
        client,
        `⚠️ Unauthorized "log hours for someone" attempt rejected\nUser: <@${userId}>`,
      );
      return;
    }

    await show(client, viewId, buildBehalfPickView(), home);
  };

  const findVolunteerOptions = async (userId: string, query: string) => {
    try {
      return (await volunteerService.searchVolunteers(userId, query)).map(
        volunteerOption,
      );
    } catch (error) {
      logError("volunteer_search_failed", error, { slackUserId: userId });
      return [];
    }
  };

  app.options(actionIds.searchVolunteer, async ({ ack, body, options }) => {
    await ack({ options: await findVolunteerOptions(body.user.id, options.value) });
  });

  app.options(actionIds.behalfFind, async ({ ack, body, options }) => {
    await ack({ options: await findVolunteerOptions(body.user.id, options.value) });
  });

  /**
   * Picking a volunteer (or "+ New volunteer") on the "log hours for someone"
   * screen moves straight on: to the hours form if they already have a
   * profile, otherwise to their details first. There is no Next button.
   */
  const continueBehalf = async (
    client: SlackClient,
    viewId: string,
    actorId: string,
    existingKey: string | null,
  ): Promise<void> => {
    await client.views.update({
      view_id: viewId,
      view: buildLoadingView("Log hours for someone"),
    });

    let next: ModalView;

    try {
      if (!(await volunteerService.canSubmitForOthers(actorId))) {
        logWarning("volunteer_authorization_denied", {
          slackUserId: actorId,
          action: "hours_for_someone",
        });
        await opsLog(
          client,
          `⚠️ Unauthorized "log hours for someone" attempt rejected\nUser: <@${actorId}>`,
        );
        next = buildMessageView(
          "Log hours for someone",
          "Only volunteer admins can log hours on someone else's behalf.",
        );
      } else {
        // A new volunteer gets a placeholder key until they're on Slack; their
        // student number is what identifies them.
        const forId = existingKey ?? volunteerService.newExternalVolunteerKey();
        // Picking yourself is just the normal flow.
        const forTarget: VolunteerTarget | null =
          forId !== actorId ? { id: forId, name: null } : null;
        const profile = await volunteerService.getProfile(forId);

        if (!profile) {
          next = existingKey
            ? buildMessageView(
                "Log hours for someone",
                "That volunteer's profile no longer exists. Go back and search again.",
              )
            : buildStudentTypeView("onboard", null, forTarget);
        } else {
          const formData = await volunteerService.getFormData();

          next =
            formData.categories.length === 0 || formData.years.length === 0
              ? buildMessageView(
                  "Log hours for someone",
                  "Volunteer hours aren't set up yet. Add a category and a volunteer year in /volunteer-admin first.",
                )
              : buildHoursFormView(
                  formData,
                  emptyHoursFormValues(),
                  forTarget ? { id: forTarget.id, name: profile.fullName } : null,
                );
        }
      }
    } catch (error) {
      logError("volunteer_hours_for_next_failed", error, {
        slackUserId: actorId,
      });
      next = buildMessageView(
        "Log hours for someone",
        "Something went wrong. Please go back and try again.",
      );
    }

    await show(client, viewId, next, "behalf");
  };

  app.action(actionIds.behalfFind, async ({ ack, action, body, client }) => {
    await ack();
    const key =
      "selected_option" in action ? action.selected_option?.value : undefined;
    const viewId = "view" in body && body.view ? body.view.id : undefined;

    if (!key || !viewId) {
      return;
    }

    await background("behalf_find", () =>
      continueBehalf(client, viewId, body.user.id, key),
    );
  });

  app.action(actionIds.behalfNew, async ({ ack, body, client }) => {
    await ack();
    const viewId = "view" in body && body.view ? body.view.id : undefined;

    if (!viewId) {
      return;
    }

    await background("behalf_new", () =>
      continueBehalf(client, viewId, body.user.id, null),
    );
  });

  const beginProfile = async (
    client: SlackClient,
    viewId: string,
    userId: string,
    home?: HubHome,
  ): Promise<void> => {
    const profile = await volunteerService.getProfile(userId);

    await show(
      client,
      viewId,
      buildStudentTypeView(profile ? "edit" : "onboard", profile),
      home,
    );
  };

  /** My hours: the volunteer's own requests as cards, each with an Edit button. */
  const beginMyHours = async (
    client: SlackClient,
    viewId: string,
    userId: string,
    home?: HubHome,
    notice: string | null = null,
  ): Promise<void> => {
    const [myHours, requests] = await Promise.all([
      volunteerService.getMyHours(userId),
      volunteerService.listMyRequests(userId),
    ]);

    await client.views.update({
      view_id: viewId,
      view: buildRequestsView({
        title: "My hours",
        heading: `*Your hours*\n*Approved:* ${formatHours(myHours.approvedHours)} h   *Pending:* ${formatHours(myHours.pendingHours)} h   *Disapproved:* ${formatHours(myHours.rejectedHours)} h`,
        requests,
        back: home ?? "member",
        editBack: "my",
        emptyText:
          "You haven't logged any volunteer hours yet. Go back and choose *Log hours* to add some.",
        notice,
      }),
    });
  };

  /** An admin looking a volunteer up: their requests as cards. */
  const buildRecordsListView = async (
    actorId: string,
    volunteerKey: string,
    notice: string | null = null,
  ): Promise<ModalView> => {
    const requests = await volunteerService.listRequestsFor(
      actorId,
      volunteerKey,
    );

    if (requests === null) {
      logWarning("volunteer_authorization_denied", {
        slackUserId: actorId,
        action: "volunteer_records",
      });
      return buildMessageView(
        "Volunteer requests",
        "Only volunteer admins can look up other volunteers' requests.",
      );
    }

    const profile = await volunteerService.getProfile(volunteerKey);

    if (!profile) {
      return buildMessageView(
        "Volunteer requests",
        "That volunteer no longer exists.",
      );
    }

    // Approvers can decide a pending request right here, as they can from the
    // queue and the channel card; everyone else just sees the cards.
    const canDecide = await volunteerService.canApprove(actorId);

    return buildRequestsView({
      title: "Volunteer requests",
      heading: `*${escapeSlackText(profile.fullName)}*\n${requestTotals(requests)}`,
      requests,
      back: "admin",
      editBack: `records:${volunteerKey}`,
      emptyText: `${escapeSlackText(profile.fullName)} hasn't logged any hours yet.`,
      notice,
      ...(canDecide ? { decide: { returnTo: `records:${volunteerKey}` } } : {}),
    });
  };

  const showRecordsFor = async (
    client: SlackClient,
    viewId: string,
    userId: string,
    volunteerKey: string,
  ): Promise<void> => {
    await client.views.update({
      view_id: viewId,
      view: await buildRecordsListView(userId, volunteerKey),
    });
  };

  app.view(callbackIds.profileType, async ({ ack, view }) => {
    const metadata = parseJsonMetadata<ProfileTypeMetadata>(
      view.private_metadata,
    );
    const selected =
      view.state.values[blockIds.studentType]?.student_type?.selected_option
        ?.value;

    if (!isStudentType(selected)) {
      await ack({
        response_action: "errors",
        errors: { [blockIds.studentType]: "Choose one option." },
      });
      return;
    }

    await ack({
      response_action: "update",
      view: buildProfileFormView(
        metadata.mode ?? "onboard",
        selected,
        metadata.existing ?? null,
        targetFromMetadata(metadata),
      ),
    });
  });

  app.view(callbackIds.profileForm, async ({ ack, body, client, view }) => {
    const metadata = parseJsonMetadata<{
      mode: ProfileMode;
      studentType: StudentType;
      forUserId: string | null;
      forName: string | null;
    }>(view.private_metadata);
    // Set when an exec is entering the profile for another volunteer.
    const forTarget = targetFromMetadata(metadata);
    const forUserId = forTarget?.id ?? null;
    const studentType = metadata.studentType;
    const mode: ProfileMode = metadata.mode ?? "onboard";

    if (!isStudentType(studentType)) {
      await ack({
        response_action: "errors",
        errors: { [blockIds.firstName]: "Something went wrong. Please start again." },
      });
      return;
    }

    const values: StateValuesLike = view.state.values;
    const input: ProfileFormInput = {
      studentType,
      firstName: values[blockIds.firstName]?.first_name?.value ?? "",
      lastName: values[blockIds.lastName]?.last_name?.value ?? "",
      preferredEmail:
        values[blockIds.preferredEmail]?.preferred_email?.value ?? "",
      email: values[blockIds.email]?.email?.value ?? "",
      utorid: values[blockIds.utorid]?.utorid?.value ?? "",
      studentNumber: values[blockIds.studentNumber]?.student_number?.value ?? "",
    };
    const actorId = body.user.id;
    const slackUserId = forUserId ?? actorId;
    const attempt = volunteerService.saveProfile(slackUserId, input, actorId);

    let first;
    try {
      first = await settleWithin(attempt, ACK_BUDGET_MS);
    } catch (error) {
      logError("volunteer_profile_save_failed", error, { slackUserId, actorId });
      await ack({
        response_action: "errors",
        errors: { [blockIds.firstName]: "Something went wrong. Please try again." },
      });
      return;
    }

    if (first.settled && !first.value.ok) {
      await ack({
        response_action: "errors",
        errors: profileErrors(first.value.issues),
      });
      return;
    }

    // Editing your own profile ends on a confirmation screen; entering a
    // profile as part of logging hours carries straight on to the hours form.
    const tellEdit = makeFeedback(client, view.id, actorId, "My profile", [
      {
        label: "Back to home",
        actionId: hubActionIds.back,
        value: "member",
        primary: true,
      },
    ]);

    await ack({
      response_action: "update",
      view:
        mode === "edit"
          ? buildLoadingView("My profile", "Saving…")
          : buildLoadingView("Log hours"),
    });

    await background("profile_saved", async () => {
      const result = first.settled ? first.value : await attempt;

      if (!result.ok) {
        const problem = `${forUserId ? "The volunteer's profile" : "Your profile"} couldn't be saved:\n${result.issues
          .map((issue) => `• ${escapeSlackText(issue.message)}`)
          .join("\n")}\nGo back and try again.`;

        if (mode === "edit") {
          await tellEdit(`⚠️ ${problem}`);
        } else {
          await show(client, view.id, buildMessageView("Log hours", `⚠️ ${problem}`));
        }
        return;
      }

      logInfo("volunteer_profile_saved", {
        slackUserId,
        studentType,
        mode,
        ...(forUserId ? { enteredBySlackUserId: actorId } : {}),
        ...(result.linkedFrom ? { linkedFromPlaceholder: result.linkedFrom } : {}),
      });

      if (result.linkedFrom) {
        // The volunteer was added by an exec before they had Slack. Their
        // Slack account now owns that record, and its hours.
        await sendDirectMessage(
          client,
          slackUserId,
          "✅ I found the volunteer record an admin set up for you and linked it to your Slack account. Any hours they logged for you now show in /volunteer → My hours.",
        );
        await opsLog(
          client,
          `🔗 <@${slackUserId}> was matched to an existing volunteer record (student number and ${studentType === "uoft" ? "UTORid" : "email"} matched).`,
        );
      }

      if (mode === "edit") {
        await tellEdit("✅ Your volunteer profile was updated.");
        return;
      }

      const formData = await volunteerService.getFormData();
      await client.views.update({
        view_id: view.id,
        view:
          formData.categories.length === 0 || formData.years.length === 0
            ? buildMessageView(
                "Log hours",
                `${forUserId ? "The profile is saved." : "Your profile is saved."} Volunteer hours aren't set up yet, so please ask an admin to add a category and a volunteer year.`,
              )
            : buildHoursFormView(
                formData,
                emptyHoursFormValues(),
                forTarget ? { id: forTarget.id, name: result.profile.fullName } : null,
              ),
      });
    });
  });

  /** The target of the ← Back button at the top of an open screen, if it has one. */
  const backTargetOf = (blocks: unknown[] | undefined): HubBack | null => {
    const first = blocks?.[0] as
      | { type?: string; elements?: Array<{ action_id?: string; value?: string }> }
      | undefined;
    const button = first?.type === "actions" ? first.elements?.[0] : undefined;

    return button?.action_id === hubActionIds.back
      ? parseHubBack(button.value)
      : null;
  };

  const changeRowCount = async (
    client: SlackClient,
    view: {
      id: string;
      hash: string;
      private_metadata: string;
      state: { values: StateValuesLike };
      blocks?: unknown[];
    },
    /** 0 redraws the form as it is (used when the category changes). */
    delta: 1 | -1 | 0,
  ): Promise<void> => {
    const metadata = parseJsonMetadata<{
      rowCount: number;
      forUserId: string | null;
      forName: string | null;
      editSubmissionId: string | null;
      editAsExec: boolean;
    }>(view.private_metadata);
    const current = Math.max(metadata.rowCount ?? 1, 1);
    const next = Math.min(
      Math.max(current + delta, 1),
      MAX_ENTRIES_PER_SUBMISSION,
    );
    const values = extractHoursFormValues(view.state.values, current);

    values.rows =
      next > current
        ? [...values.rows, { date: null, hours: "" }]
        : values.rows.slice(0, next);

    const formData = await volunteerService.getFormData();
    const rebuilt = buildHoursFormView(
      formData,
      values,
      targetFromMetadata(metadata),
      editContextFromMetadata(metadata),
    );
    // Keep the ← Back button the form was opened with.
    const back = backTargetOf(view.blocks);

    await client.views.update({
      view_id: view.id,
      hash: view.hash,
      view: back ? withBack(rebuilt, back) : rebuilt,
    });
  };

  // Choosing a category redraws the form with what has been typed so far, so
  // the Event dropdown shows (and is required) only for a category that asks
  // for an event.
  app.action(actionIds.category, async ({ ack, body, client }) => {
    await ack();
    const view = "view" in body ? body.view : undefined;

    if (!view) {
      return;
    }

    await background("category_change", () => changeRowCount(client, view, 0));
  });

  app.action(actionIds.addDate, async ({ ack, body, client }) => {
    await ack();
    const view = "view" in body ? body.view : undefined;

    if (!view) {
      return;
    }

    await background("add_date", () => changeRowCount(client, view, 1));
  });

  app.action(actionIds.removeDate, async ({ ack, body, client }) => {
    await ack();
    const view = "view" in body ? body.view : undefined;

    if (!view) {
      return;
    }

    await background("remove_date", () => changeRowCount(client, view, -1));
  });

  // The Edit button on a request card (My hours, or an admin's list of one
  // volunteer's requests). The form replaces the list, with a ← Back button.
  app.action(actionIds.editRequest, async ({ ack, action, body, client }) => {
    await ack();
    const value = "value" in action ? action.value : undefined;
    const viewId = "view" in body && body.view ? body.view.id : undefined;

    if (!value || !viewId) {
      return;
    }

    const { submissionId, back } = parseRequestEditValue(value);

    await background("edit_open", async () => {
      await client.views.update({
        view_id: viewId,
        view: buildLoadingView("Edit hours"),
      });

      let next: ModalView;
      try {
        next = await resolveEditView(body.user.id, submissionId);
      } catch (error) {
        logError("volunteer_edit_open_failed", error, {
          slackUserId: body.user.id,
        });
        next = buildMessageView(
          "Edit hours",
          "Something went wrong. Please try again.",
        );
      }

      await client.views.update({ view_id: viewId, view: withBack(next, back) });
    });
  });

  const beginRecords = async (
    client: SlackClient,
    viewId: string,
    userId: string,
    home?: HubHome,
  ): Promise<void> => {
    if (!(await volunteerService.canSubmitForOthers(userId))) {
      logWarning("volunteer_authorization_denied", {
        slackUserId: userId,
        action: "volunteer_records",
      });
      await show(
        client,
        viewId,
        buildMessageView(
          "Volunteer requests",
          "Only volunteer admins can look up other volunteers' requests. Use /volunteer, then My hours, for your own.",
        ),
        home,
      );
      await opsLog(
        client,
        `⚠️ Unauthorized volunteer records lookup rejected\nUser: <@${userId}>`,
      );
      return;
    }

    await show(client, viewId, buildRecordsPickView(), home);
  };

  app.view(callbackIds.recordsPick, async ({ ack, body, client, view }) => {
    const actorId = body.user.id;
    const volunteerKey =
      view.state.values[blockIds.recordsVolunteer]?.[actionIds.searchVolunteer]
        ?.selected_option?.value;

    if (!volunteerKey) {
      await ack({
        response_action: "errors",
        errors: { [blockIds.recordsVolunteer]: "Choose a volunteer." },
      });
      return;
    }

    const next = (): Promise<ModalView> =>
      buildRecordsListView(actorId, volunteerKey);

    await chainView({
      ack: ack as unknown as ViewSubmissionAck,
      client,
      viewId: view.id,
      actorId,
      attempt: next(),
      title: "Volunteer requests",
      errorBlockId: blockIds.recordsVolunteer,
      logName: "volunteer_records_next_failed",
    });
  });

  app.view(callbackIds.hoursForm, async ({ ack, body, client, view }) => {
    const hoursMetadata = parseJsonMetadata<{
      rowCount: number;
      forUserId: string | null;
      forName: string | null;
      editSubmissionId: string | null;
      editAsExec: boolean;
    }>(view.private_metadata);
    const editing = editContextFromMetadata(hoursMetadata);
    const wantsDelete =
      editing !== null &&
      (view.state.values[blockIds.deleteRequest]?.delete?.selected_options ?? [])
        .length > 0;

    const origin = backTargetOf(
      (view as { blocks?: unknown[] }).blocks,
    );

    if (editing && wantsDelete) {
      // Deleting needs none of the form's fields, so skip validating them.
      await ack({
        response_action: "update",
        view: buildLoadingView("Edit hours", "Deleting…"),
      });
      await background("hours_delete", () =>
        finishDelete(
          client,
          body.user.id,
          editing.submissionId,
          makeFeedback(
            client,
            view.id,
            body.user.id,
            "Edit hours",
            doneActionsFor({ editing: true, onBehalf: false, origin }),
          ),
        ),
      );
      return;
    }

    const rowCount = hoursMetadata.rowCount;
    const forUserId = hoursMetadata.forUserId ?? null;
    const form = extractHoursFormValues(view.state.values, rowCount ?? 1);
    const errors: Record<string, string> = {};

    if (!form.categoryId) {
      errors[blockIds.category] = "Choose a category.";
    }

    if (!form.description.trim()) {
      errors[blockIds.description] = "Describe what you did.";
    }

    const entries: Array<{ entryDate: string; hours: number }> = [];
    const rowIndexes: number[] = [];

    form.rows.forEach((row, index) => {
      const hasDate = Boolean(row.date);
      const hasHours = row.hours !== "";

      if (!hasDate && !hasHours) {
        if (index === 0) {
          errors[blockIds.date(0)] = "Choose a date.";
          errors[blockIds.hours(0)] = "Enter your hours.";
        }
        return;
      }

      if (!row.date) {
        errors[blockIds.date(index)] = "Choose a date.";
        return;
      }

      const hours = Number(row.hours);

      if (!hasHours || !Number.isFinite(hours)) {
        errors[blockIds.hours(index)] = "Enter your hours.";
        return;
      }

      entries.push({ entryDate: row.date, hours });
      rowIndexes.push(index);
    });

    if (Object.keys(errors).length > 0) {
      await ack({ response_action: "errors", errors });
      return;
    }

    // An admin entering hours for someone else: the hours belong to the
    // volunteer, and the person typing them in is recorded as the submitter.
    const submittedBySlackUserId = body.user.id;
    const volunteerSlackUserId = forUserId ?? submittedBySlackUserId;
    const onBehalf = volunteerSlackUserId !== submittedBySlackUserId;
    // Someone an exec entered hours for may have no Slack account to mention.
    const volunteerLabel = hasSlackAccount(volunteerSlackUserId)
      ? `<@${volunteerSlackUserId}>`
      : `*${escapeSlackText(hoursMetadata.forName ?? "the volunteer")}*`;
    const attempt = volunteerService.prepareSubmission({
      slackSubmissionId: view.id,
      volunteerSlackUserId,
      submittedBySlackUserId,
      ...(editing ? { editingSubmissionId: editing.submissionId } : {}),
      categoryId: form.categoryId ?? "",
      eventId: form.eventId,
      description: form.description,
      entries,
    });

    let first;
    try {
      first = await settleWithin(attempt, ACK_BUDGET_MS);
    } catch (error) {
      logError("volunteer_submission_prepare_failed", error, {
        slackUserId: volunteerSlackUserId,
        submittedBySlackUserId,
      });
      await ack({
        response_action: "errors",
        errors: {
          [blockIds.category]: "Something went wrong. Please try again.",
        },
      });
      return;
    }

    if (first.settled && !first.value.ok) {
      await ack({
        response_action: "errors",
        errors: submissionErrors(first.value.issues, rowIndexes),
      });
      return;
    }

    const doneTitle = editing
      ? "Edit hours"
      : onBehalf
        ? "Log hours for someone"
        : "Log hours";

    // Keep the window open on a "Saving…" screen; it becomes the result.
    await ack({
      response_action: "update",
      view: buildLoadingView(doneTitle, "Saving…"),
    });

    const tell = makeFeedback(
      client,
      view.id,
      submittedBySlackUserId,
      doneTitle,
      doneActionsFor({ editing: editing !== null, onBehalf, origin }),
    );

    await background("hours_submit", async () => {
      const prepared = first.settled ? first.value : await attempt;

      if (!prepared.ok) {
        await tell(
          editing
            ? `⚠️ Your changes couldn't be saved:\n${issueSummary(prepared.issues)}\nGo back and try again.`
            : `⚠️ ${onBehalf ? `The hours for ${volunteerLabel}` : "Your volunteer hours"} couldn't be submitted:\n${issueSummary(prepared.issues)}\nGo back and try again.`,
        );
        return;
      }

      if (editing) {
        await finishEdit(client, submittedBySlackUserId, prepared.prepared, tell);
        return;
      }

      const { submission, created } = await volunteerService.createSubmission(
        prepared.prepared,
      );

      if (!created) {
        logInfo("duplicate_volunteer_submission_ignored", {
          submissionId: submission.id,
          slackSubmissionId: submission.slackSubmissionId,
        });
        await tell("✅ That was already submitted.");
        return;
      }

      logInfo("volunteer_hours_submitted", {
        submissionId: submission.id,
        volunteerSlackUserId,
        ...(onBehalf ? { submittedBySlackUserId } : {}),
        entryCount: submission.entries.length,
      });

      if (onBehalf) {
        await opsLog(
          client,
          `📝 <@${submittedBySlackUserId}> logged and approved hours for ${volunteerLabel} on their behalf\nSubmission ID: ${submission.id}`,
        );
      }

      try {
        const primary = await volunteerService.getPrimaryApprover();
        const card = buildApprovalCard(
          submission,
          primary?.slackUserId ?? null,
        );
        const posted = await client.chat.postMessage({
          channel: approvalsChannelId,
          text: card.text,
          blocks: card.blocks,
        });

        if (posted.ts && posted.channel) {
          await volunteerService.recordApprovalMessage(
            submission.id,
            posted.channel,
            posted.ts,
          );
        }
      } catch (error) {
        logError("volunteer_approval_card_failed", error, {
          submissionId: submission.id,
        });
        await opsLog(
          client,
          `❌ Volunteer hours were saved but the approval card couldn't be posted.\nSubmission ID: ${submission.id}\nVolunteer: ${volunteerLabel}`,
        );
        await tell(
          `⚠️ ${onBehalf ? `The hours for ${volunteerLabel} were` : "Your hours were"} saved, but I couldn't notify the approvers. An admin has been alerted.`,
        );
        return;
      }

      if (!onBehalf) {
        await tell(submissionReceivedText(submission));
        return;
      }

      await tell(submissionOnBehalfForSubmitterText(submission));

      // No Slack account means nobody to message; the exec was told above.
      if (
        hasSlackAccount(volunteerSlackUserId) &&
        !(await sendDirectMessage(
          client,
          volunteerSlackUserId,
          submissionOnBehalfForVolunteerText(submission),
        ))
      ) {
        await sendDirectMessage(
          client,
          submittedBySlackUserId,
          `⚠️ I couldn't message ${volunteerLabel} to let them know. The hours are still pending approval.`,
        );
      }
    });
  });

  /** The approvers' queue of pending requests. */
  const beginPending = async (
    client: SlackClient,
    viewId: string,
    userId: string,
    home?: HubHome,
    notice: string | null = null,
  ): Promise<void> => {
    const queue = await volunteerService.getPendingQueue(userId);

    await client.views.update({
      view_id: viewId,
      view: queue
        ? buildPendingView({
            requests: queue.requests,
            total: queue.total,
            canApprove: queue.canApprove,
            notice,
            back: home ?? "exec",
          })
        : buildMessageView(
            "Pending requests",
            "Only volunteer execs and admins can see the pending requests.",
          ),
    });
  };

  /** What the queue says after a decision. */
  const decisionNotice = (result: DecisionResult): string => {
    switch (result.status) {
      case "ok": {
        const who = escapeSlackText(result.submission.volunteerName);
        const hours = formatHours(totalHours(result.submission));

        return result.submission.status === "approved"
          ? `Approved ${who}'s ${hours} h.`
          : `Disapproved ${who}'s ${hours} h. They've been told why.`;
      }
      case "not_authorized":
        return "⚠️ You don't have permission to approve volunteer hours.";
      case "not_found":
        return "⚠️ That request no longer exists.";
      case "note_required":
        return "⚠️ A reason is required to disapprove hours.";
      case "stale":
        return "⚠️ That request was just edited, so your click was ignored. Review it again below.";
      case "already_decided": {
        const decider = result.submission.decidedBySlackUserId;

        return `⚠️ That request was already ${result.submission.status === "approved" ? "approved" : "disapproved"}${decider ? ` by <@${decider}>` : ""}.`;
      }
    }
  };

  /**
   * A decision made in the queue: the same side effects as one made on the
   * channel card (the card updates, the volunteer is told), then the queue
   * redraws with what happened at the top.
   */
  const finishQueueDecision = async (
    client: SlackClient,
    result: DecisionResult,
    actorId: string,
    submissionId: string,
    viewId: string,
    home: HubHome,
  ): Promise<void> => {
    await handleDecision(client, result, actorId, submissionId, null, async () => undefined);
    await beginPending(client, viewId, actorId, home, decisionNotice(result));
  };

  const queueHomeOf = (blocks: unknown[] | undefined): "exec" | "admin" =>
    backTargetOf(blocks) === "admin" ? "admin" : "exec";

  /** The volunteer whose request list a decision button came from, if it came from one. */
  const recordsKeyOf = (returnTo: string | null): string | null =>
    returnTo?.startsWith("records:") && returnTo.length > "records:".length
      ? returnTo.slice("records:".length)
      : null;

  /**
   * A decision made on a volunteer's request list: the same side effects as one
   * made on the channel card or in the queue (the card updates, the volunteer is
   * told), then that volunteer's list redraws with what happened at the top.
   */
  const finishRecordsDecision = async (
    client: SlackClient,
    result: DecisionResult,
    actorId: string,
    submissionId: string,
    viewId: string,
    volunteerKey: string,
  ): Promise<void> => {
    await handleDecision(client, result, actorId, submissionId, null, async () => undefined);
    await client.views.update({
      view_id: viewId,
      view: await buildRecordsListView(actorId, volunteerKey, decisionNotice(result)),
    });
  };

  app.action(actionIds.approve, async ({ ack, action, body, client }) => {
    await ack();
    const value = "value" in action ? action.value : undefined;

    if (!value) {
      return;
    }

    const { submissionId, version, returnTo } = parseDecisionValue(value);
    const channelId = body.channel?.id ?? null;
    // Pressed on the approvers' queue (a window) rather than a channel card.
    const queueView = "view" in body && body.view ? body.view : undefined;
    const recordsKey = queueView ? recordsKeyOf(returnTo) : null;

    await background("approve", async () => {
      const result = await volunteerService.decide({
        submissionId,
        decidedBySlackUserId: body.user.id,
        decision: "approved",
        note: null,
        ...(version !== null ? { expectedVersion: version } : {}),
      });

      if (queueView && recordsKey) {
        await finishRecordsDecision(client, result, body.user.id, submissionId, queueView.id, recordsKey);
        return;
      }

      if (queueView) {
        await finishQueueDecision(
          client,
          result,
          body.user.id,
          submissionId,
          queueView.id,
          queueHomeOf((queueView as { blocks?: unknown[] }).blocks),
        );
        return;
      }

      await handleDecision(client, result, body.user.id, submissionId, channelId);
    });
  });

  app.action(actionIds.disapprove, async ({ ack, action, body, client }) => {
    await ack();
    const value = "value" in action ? action.value : undefined;
    const triggerId = "trigger_id" in body ? body.trigger_id : undefined;
    const queueView = "view" in body && body.view ? body.view : undefined;

    if (!value || (!triggerId && !queueView)) {
      return;
    }

    const { submissionId, version, returnTo } = parseDecisionValue(value);
    const recordsKey = queueView ? recordsKeyOf(returnTo) : null;

    if (queueView && recordsKey) {
      // From a volunteer's request list the reason form replaces the list, with
      // a Back button to it, instead of opening a second window.
      await background("disapprove_records", async () => {
        await show(
          client,
          queueView.id,
          buildRejectReasonView(submissionId, version, null, `records:${recordsKey}`),
          `records:${recordsKey}`,
        );
      });
      return;
    }

    if (queueView) {
      // From the approvers' queue the reason form replaces the queue, with a
      // Back button, instead of opening a second window.
      const home = queueHomeOf((queueView as { blocks?: unknown[] }).blocks);

      await background("disapprove_queue", async () => {
        await show(
          client,
          queueView.id,
          buildRejectReasonView(submissionId, version, home),
          home === "admin" ? "pending:admin" : "pending",
        );
      });
      return;
    }

    if (!triggerId) {
      return;
    }

    // Opens before any DB work so the trigger_id can't expire on a cold start.
    // Approver permission is enforced when the reason is submitted.
    await background("disapprove_open", async () => {
      await client.views.open({
        trigger_id: triggerId,
        view: buildRejectReasonView(submissionId, version),
      });
    });
  });

  app.view(callbackIds.rejectReason, async ({ ack, body, client, view }) => {
    const { submissionId, version, queue, returnTo } = parseJsonMetadata<{
      submissionId: string;
      version: number | null;
      queue: HubHome;
      returnTo?: string;
    }>(view.private_metadata);
    const recordsKey = recordsKeyOf(returnTo ?? null);
    const reason = view.state.values[blockIds.reason]?.reason?.value?.trim();

    if (!reason) {
      await ack({
        response_action: "errors",
        errors: { [blockIds.reason]: "Enter a reason." },
      });
      return;
    }

    const fromQueue = queue === "exec" || queue === "admin" ? queue : null;

    if (recordsKey) {
      await ack({
        response_action: "update",
        view: buildLoadingView("Volunteer requests", "Saving…"),
      });
    } else if (fromQueue) {
      await ack({
        response_action: "update",
        view: buildLoadingView("Pending requests", "Saving…"),
      });
    } else {
      await ack();
    }

    if (!submissionId) {
      return;
    }

    await background("disapprove", async () => {
      const result = await volunteerService.decide({
        submissionId,
        decidedBySlackUserId: body.user.id,
        decision: "rejected",
        note: reason,
        ...(typeof version === "number" ? { expectedVersion: version } : {}),
      });

      if (recordsKey) {
        await finishRecordsDecision(
          client,
          result,
          body.user.id,
          submissionId,
          view.id,
          recordsKey,
        );
        return;
      }

      if (fromQueue) {
        await finishQueueDecision(
          client,
          result,
          body.user.id,
          submissionId,
          view.id,
          fromQueue,
        );
        return;
      }

      await handleDecision(client, result, body.user.id, submissionId, null);
    });
  });

  const context = { app, background, opsLog, sendDirectMessage };
  const { beginReport, beginLetters } = registerVolunteerReportHandlers(
    context,
    services.reports,
  );
  registerVolunteerAdminHandlers(context, services.admin, { beginReport });

  registerVolunteerHubs(context, services, {
    beginHours,
    beginHoursFor,
    beginProfile,
    beginMyHours,
    beginRecords,
    beginReport,
    beginLetters,
    beginPending,
    showRecordsFor,
  });

  return app;
}
