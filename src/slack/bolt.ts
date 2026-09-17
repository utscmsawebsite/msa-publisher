import { App } from "@slack/bolt";
import type { Receiver } from "@slack/bolt";
import type {
  EventDraft,
  EventUpdate,
  ManageableEvent,
} from "../domain/content.js";
import type { JummahContent } from "../domain/jummah.js";
import { logError, logInfo, logWarning } from "../logging/application-logger.js";
import {
  EventCreationError,
  EventUpdateError,
  type ContentService,
} from "../services/content.service.js";
import type { JummahService } from "../services/jummah.service.js";
import type { ImageUpload } from "../storage/image.storage.js";

const acceptedImageTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

async function downloadSlackImages(
  files: Array<{
    name: string;
    mimetype: string;
    size?: number;
    url_private_download: string;
  }>,
  botToken: string,
): Promise<ImageUpload[]> {
  return Promise.all(
    files.map(async (file) => {
      if (!acceptedImageTypes.has(file.mimetype)) {
        throw new Error(`Unsupported image type: ${file.mimetype}`);
      }

      const response = await fetch(file.url_private_download, {
        headers: {
          Authorization: `Bearer ${botToken}`,
        },
      });

      if (!response.ok || !response.body) {
        throw new Error(
          `Unable to download ${file.name} from Slack (${response.status}).`,
        );
      }

      return {
        originalName: file.name,
        mimeType: file.mimetype,
        sizeBytes: file.size ?? null,
        body: response.body,
      };
    }),
  );
}

async function sendCommandResponse(
  responseUrl: string,
  text: string,
): Promise<void> {
  const response = await fetch(responseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      response_type: "ephemeral",
      text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Slack response failed (${response.status}).`);
  }
}

type BackgroundTaskScheduler = (task: Promise<unknown>) => void;

interface SlackAppOptions {
  receiver?: Receiver;
  scheduleBackgroundTask?: BackgroundTaskScheduler;
}

type SlackModalView = Parameters<
  App["client"]["views"]["open"]
>[0]["view"];

interface EditViewMetadata {
  eventId?: string;
  responseUrl?: string;
}

function parseEditViewMetadata(value: string): EditViewMetadata {
  try {
    return JSON.parse(value) as EditViewMetadata;
  } catch {
    return {};
  }
}

function truncateSlackText(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value;
  }

  return `${value.slice(0, maximumLength - 1)}…`;
}

function eventOptionLabel(event: ManageableEvent): string {
  return truncateSlackText(
    `Event · ${event.title} · ${event.eventDate}`,
    75,
  );
}

function jummahViewMetadata(responseUrl: string | undefined): string {
  return JSON.stringify({ responseUrl });
}

function buildJummahScheduleView(
  current: JummahContent | null,
  responseUrl: string | undefined,
): SlackModalView {
  return {
    type: "modal",
    callback_id: "update_jummah",
    private_metadata: jummahViewMetadata(responseUrl),
    title: {
      type: "plain_text",
      text: "Update Jummah",
    },
    submit: {
      type: "plain_text",
      text: "Save",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks: [
      {
        type: "input",
        block_id: "first_start_time",
        label: {
          type: "plain_text",
          text: "First Jummah start time",
        },
        element: {
          type: "timepicker",
          action_id: "time_input",
          ...(current ? { initial_time: current.firstStartTime } : {}),
        },
      },
      {
        type: "input",
        block_id: "first_end_time",
        label: {
          type: "plain_text",
          text: "First Jummah end time",
        },
        element: {
          type: "timepicker",
          action_id: "time_input",
          ...(current ? { initial_time: current.firstEndTime } : {}),
        },
      },
      {
        type: "input",
        block_id: "first_location",
        label: {
          type: "plain_text",
          text: "First Jummah location",
        },
        element: {
          type: "plain_text_input",
          action_id: "location_input",
          ...(current ? { initial_value: current.firstLocation } : {}),
        },
      },
      {
        type: "divider",
      },
      {
        type: "input",
        block_id: "second_start_time",
        optional: true,
        label: {
          type: "plain_text",
          text: "Second Jummah start time",
        },
        hint: {
          type: "plain_text",
          text: "Optional; start and end must be provided together.",
        },
        element: {
          type: "timepicker",
          action_id: "time_input",
          ...(current?.secondStartTime
            ? { initial_time: current.secondStartTime }
            : {}),
        },
      },
      {
        type: "input",
        block_id: "second_end_time",
        optional: true,
        label: {
          type: "plain_text",
          text: "Second Jummah end time",
        },
        element: {
          type: "timepicker",
          action_id: "time_input",
          ...(current?.secondEndTime
            ? { initial_time: current.secondEndTime }
            : {}),
        },
      },
      {
        type: "input",
        block_id: "second_location",
        optional: true,
        label: {
          type: "plain_text",
          text: "Second Jummah location",
        },
        hint: {
          type: "plain_text",
          text: "Defaults to the first location when left empty.",
        },
        element: {
          type: "plain_text_input",
          action_id: "location_input",
          ...(current?.secondLocation
            ? { initial_value: current.secondLocation }
            : {}),
        },
      },
      ...(current
        ? [
            {
              type: "divider" as const,
            },
            {
              type: "actions" as const,
              block_id: "jummah_availability_actions",
              elements: [
                {
                  type: "button" as const,
                  action_id: "show_jummah_unavailable",
                  text: {
                    type: "plain_text" as const,
                    text: "Jummah not happening this week",
                  },
                },
              ],
            },
          ]
        : []),
    ],
  };
}

function buildJummahUnavailableView(
  current: JummahContent,
  responseUrl: string | undefined,
): SlackModalView {
  return {
    type: "modal",
    callback_id: "update_jummah_unavailable",
    private_metadata: jummahViewMetadata(responseUrl),
    title: {
      type: "plain_text",
      text: "Jummah Unavailable",
    },
    submit: {
      type: "plain_text",
      text: "Save",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Use this status when Jummah is not being offered on campus. The saved schedule will be kept for when Jummah resumes.",
        },
      },
      {
        type: "input",
        block_id: "unavailable_message",
        label: {
          type: "plain_text",
          text: "Message for the website",
        },
        element: {
          type: "plain_text_input",
          action_id: "message_input",
          multiline: true,
          initial_value:
            current.unavailableMessage ??
            "Jummah is not offered on campus this week. Please visit a nearby masjid.",
        },
      },
      {
        type: "actions",
        block_id: "jummah_availability_actions",
        elements: [
          {
            type: "button",
            action_id: "show_jummah_schedule",
            text: {
              type: "plain_text",
              text: "Jummah is happening this week",
            },
          },
        ],
      },
    ],
  };
}

async function sendSlackLog(
  client: App["client"],
  channelId: string,
  text: string,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await client.chat.postMessage({
      channel: channelId,
      text,
    });
  } catch (error) {
    logError("slack_log_delivery_failed", error, context);
  }
}

function getAllowedSlackUserIds(): ReadonlySet<string> {
  const configuredIds = process.env.SLACK_ALLOWED_USER_IDS;

  if (!configuredIds?.trim()) {
    throw new Error(
      "SLACK_ALLOWED_USER_IDS must contain at least one Slack member ID.",
    );
  }

  const userIds = configuredIds
    .split(",")
    .map((userId) => userId.trim())
    .filter(Boolean);

  if (userIds.length === 0) {
    throw new Error(
      "SLACK_ALLOWED_USER_IDS must contain at least one Slack member ID.",
    );
  }

  return new Set(userIds);
}

export function createSlackApp(
  contentService: ContentService,
  jummahService: JummahService,
  options: SlackAppOptions = {},
): App {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const allowedSlackUserIds = getAllowedSlackUserIds();
  const logChannelId = process.env.SLACK_LOG_CHANNEL_ID?.trim();

  if (!botToken) {
    throw new Error(
      "SLACK_BOT_TOKEN must be defined in the environment variables.",
    );
  }

  if (!logChannelId) {
    throw new Error(
      "SLACK_LOG_CHANNEL_ID must be defined in the environment variables.",
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
    const appToken = process.env.SLACK_APP_TOKEN;

    if (!appToken) {
      throw new Error(
        "SLACK_APP_TOKEN must be defined when using Socket Mode.",
      );
    }

    app = new App({
      token: botToken,
      appToken,
      socketMode: true,
    });
  }

  const cleanupStaleEvents = async (
    client: App["client"],
    triggeredBy: "event_saved" | "event_edited",
    slackUserId: string,
  ): Promise<void> => {
    try {
      const result = await contentService.cleanupStaleEvents();

      if (result.deletedEvents.length === 0) {
        return;
      }

      logInfo("stale_events_deleted", {
        triggeredBy,
        slackUserId,
        eventCount: result.deletedEvents.length,
        imageCount: result.deletedEvents.reduce(
          (count, event) => count + event.imageUrls.length,
          0,
        ),
        blobCleanupSucceeded: result.blobCleanupSucceeded,
      });

      if (!result.blobCleanupSucceeded) {
        logWarning("stale_event_blob_cleanup_failed", {
          triggeredBy,
          eventIds: result.deletedEvents.map((event) => event.id),
        });
      }

      await sendSlackLog(
        client,
        logChannelId,
        [
          `🧹 Removed ${result.deletedEvents.length} stale event(s)`,
          `Triggered by: ${triggeredBy} from <@${slackUserId}>`,
          result.blobCleanupSucceeded
            ? "Blob cleanup: complete"
            : "⚠️ Some stale Blob images may require manual cleanup.",
        ].join("\n"),
        {
          triggeredBy,
          slackUserId,
          eventIds: result.deletedEvents.map((event) => event.id),
        },
      );
    } catch (error) {
      logError("stale_event_cleanup_failed", error, {
        triggeredBy,
        slackUserId,
      });

      await sendSlackLog(
        client,
        logChannelId,
        [
          "❌ Stale-event cleanup failed",
          `Triggered by: ${triggeredBy} from <@${slackUserId}>`,
        ].join("\n"),
        {
          triggeredBy,
          slackUserId,
        },
      );
    }
  };

  app.command("/event", async ({ ack, command, client, respond }) => {
    if (!allowedSlackUserIds.has(command.user_id)) {
      await ack({
        response_type: "ephemeral",
        text: "You are not authorized to create events.",
      });

      logWarning("slack_authorization_denied", {
        slackUserId: command.user_id,
        action: "/event",
      });

      const notifyAdministrators = sendSlackLog(
        client,
        logChannelId,
        [
          "⚠️ Unauthorized event command rejected",
          `User ID: ${command.user_id}`,
          "Action: /event",
        ].join("\n"),
        {
          slackUserId: command.user_id,
          action: "/event",
        },
      );

      if (options.scheduleBackgroundTask) {
        options.scheduleBackgroundTask(notifyAdministrators);
      } else {
        await notifyAdministrators;
      }

      return;
    }

    await ack();

    const openEventForm = async () => {
      try {
        await client.views.open({
          trigger_id: command.trigger_id,
          view: {
            type: "modal",
            callback_id: "create_event",
            private_metadata: JSON.stringify({
              responseUrl: command.response_url,
            }),
            title: {
              type: "plain_text",
              text: "Create Event",
            },
            submit: {
              type: "plain_text",
              text: "Create",
            },
            close: {
              type: "plain_text",
              text: "Cancel",
            },
            blocks: [
              {
                type: "input",
                block_id: "event_title",
                label: {
                  type: "plain_text",
                  text: "Title",
                },
                element: {
                  type: "plain_text_input",
                  action_id: "title_input",
                },
              },
              {
                type: "input",
                block_id: "event_description",
                label: {
                  type: "plain_text",
                  text: "Description",
                },
                element: {
                  type: "plain_text_input",
                  action_id: "description_input",
                  multiline: true,
                },
              },
              {
                type: "input",
                block_id: "event_date",
                label: {
                  type: "plain_text",
                  text: "Event date",
                },
                hint: {
                  type: "plain_text",
                  text: "The post will be removed from the website the following day.",
                },
                element: {
                  type: "datepicker",
                  action_id: "event_date_input",
                },
              },
              {
                type: "input",
                block_id: "start_time",
                label: {
                  type: "plain_text",
                  text: "Start time",
                },
                element: {
                  type: "timepicker",
                  action_id: "start_time_input",
                },
              },
              {
                type: "input",
                block_id: "end_time",
                label: {
                  type: "plain_text",
                  text: "End time",
                },
                element: {
                  type: "timepicker",
                  action_id: "end_time_input",
                },
              },
              {
                type: "input",
                block_id: "event_images",
                label: {
                  type: "plain_text",
                  text: "Images",
                },
                element: {
                  type: "file_input",
                  action_id: "images_input",
                  filetypes: ["jpg", "jpeg", "png", "webp"],
                  max_files: 5,
                },
              },
            ],
          },
        });

      } catch (error) {
        logError("event_form_open_failed", error, {
          slackUserId: command.user_id,
        });
        await respond("Sorry, the event form could not be opened.");
      }
    };

    if (options.scheduleBackgroundTask) {
      options.scheduleBackgroundTask(openEventForm());
      return;
    }

    await openEventForm();
  });

  app.command("/jummah", async ({ ack, command, client, respond }) => {
    if (!allowedSlackUserIds.has(command.user_id)) {
      await ack({
        response_type: "ephemeral",
        text: "You are not authorized to update Jummah information.",
      });

      logWarning("slack_authorization_denied", {
        slackUserId: command.user_id,
        action: "/jummah",
      });

      const notifyAdministrators = sendSlackLog(
        client,
        logChannelId,
        [
          "⚠️ Unauthorized Jummah command rejected",
          `User ID: ${command.user_id}`,
          "Action: /jummah",
        ].join("\n"),
        {
          slackUserId: command.user_id,
          action: "/jummah",
        },
      );

      if (options.scheduleBackgroundTask) {
        options.scheduleBackgroundTask(notifyAdministrators);
      } else {
        await notifyAdministrators;
      }

      return;
    }

    await ack();

    const openJummahForm = async () => {
      try {
        const current = await jummahService.getCurrent();

        await client.views.open({
          trigger_id: command.trigger_id,
          view:
            current && !current.isOffered
              ? buildJummahUnavailableView(
                  current,
                  command.response_url,
                )
              : buildJummahScheduleView(current, command.response_url),
        });

        logInfo("jummah_form_opened", {
          slackUserId: command.user_id,
          existingSchedule: Boolean(current),
          isOffered: current?.isOffered ?? null,
        });
      } catch (error) {
        logError("jummah_form_open_failed", error, {
          slackUserId: command.user_id,
        });
        await respond("Sorry, the Jummah form could not be opened.");
      }
    };

    if (options.scheduleBackgroundTask) {
      options.scheduleBackgroundTask(openJummahForm());
      return;
    }

    await openJummahForm();
  });

  app.command("/event-edit", async ({ ack, command, client, respond }) => {
    if (!allowedSlackUserIds.has(command.user_id)) {
      await ack({
        response_type: "ephemeral",
        text: "You are not authorized to manage events.",
      });

      logWarning("slack_authorization_denied", {
        slackUserId: command.user_id,
        action: "/event-edit",
      });

      const notifyAdministrators = sendSlackLog(
        client,
        logChannelId,
        [
          "⚠️ Unauthorized event-edit command rejected",
          `User ID: ${command.user_id}`,
          "Action: /event-edit",
        ].join("\n"),
        {
          slackUserId: command.user_id,
          action: "/event-edit",
        },
      );

      if (options.scheduleBackgroundTask) {
        options.scheduleBackgroundTask(notifyAdministrators);
      } else {
        await notifyAdministrators;
      }

      return;
    }

    await ack();

    const openEventPicker = async () => {
      try {
        const events = await contentService.listManageableEvents();

        await client.views.open({
          trigger_id: command.trigger_id,
          view: {
            type: "modal",
            callback_id: "select_event_to_edit",
            private_metadata: JSON.stringify({
              responseUrl: command.response_url,
            }),
            title: {
              type: "plain_text",
              text: "Manage Events",
            },
            close: {
              type: "plain_text",
              text: "Cancel",
            },
            blocks:
              events.length === 0
                ? [
                    {
                      type: "section",
                      text: {
                        type: "mrkdwn",
                        text: "There are no upcoming events to manage.",
                      },
                    },
                  ]
                : [
                    {
                      type: "section",
                      block_id: "event_picker",
                      text: {
                        type: "mrkdwn",
                        text: "Choose an event to edit or delete:",
                      },
                      accessory: {
                        type: "static_select",
                        action_id: "select_event_to_edit",
                        placeholder: {
                          type: "plain_text",
                          text: "Select an event",
                        },
                        options: events.map((event) => ({
                          text: {
                            type: "plain_text" as const,
                            text: eventOptionLabel(event),
                          },
                          value: event.id,
                        })),
                      },
                    },
                  ],
          },
        });

        logInfo("event_picker_opened", {
          slackUserId: command.user_id,
          eventCount: events.length,
        });
      } catch (error) {
        logError("event_picker_open_failed", error, {
          slackUserId: command.user_id,
        });
        await respond("Sorry, the event manager could not be opened.");
      }
    };

    if (options.scheduleBackgroundTask) {
      options.scheduleBackgroundTask(openEventPicker());
      return;
    }

    await openEventPicker();
  });

  app.action(
    "show_jummah_unavailable",
    async ({ ack, body, client }) => {
      await ack();

      if (!allowedSlackUserIds.has(body.user.id)) {
        logWarning("slack_authorization_denied", {
          slackUserId: body.user.id,
          action: "show_jummah_unavailable",
        });
        return;
      }

      const currentView = "view" in body ? body.view : undefined;
      if (!currentView) {
        return;
      }

      const showUnavailableForm = async () => {
        try {
          const current = await jummahService.getCurrent();
          if (!current) {
            throw new Error(
              "A Jummah schedule must be saved before it can be marked unavailable.",
            );
          }

          const metadata = parseEditViewMetadata(
            currentView.private_metadata,
          );
          await client.views.update({
            view_id: currentView.id,
            hash: currentView.hash,
            view: buildJummahUnavailableView(
              current,
              metadata.responseUrl,
            ),
          });

          logInfo("jummah_unavailable_form_opened", {
            slackUserId: body.user.id,
          });
        } catch (error) {
          logError("jummah_unavailable_form_open_failed", error, {
            slackUserId: body.user.id,
          });
        }
      };

      if (options.scheduleBackgroundTask) {
        options.scheduleBackgroundTask(showUnavailableForm());
        return;
      }

      await showUnavailableForm();
    },
  );

  app.action("show_jummah_schedule", async ({ ack, body, client }) => {
    await ack();

    if (!allowedSlackUserIds.has(body.user.id)) {
      logWarning("slack_authorization_denied", {
        slackUserId: body.user.id,
        action: "show_jummah_schedule",
      });
      return;
    }

    const currentView = "view" in body ? body.view : undefined;
    if (!currentView) {
      return;
    }

    const showScheduleForm = async () => {
      try {
        const current = await jummahService.getCurrent();
        const metadata = parseEditViewMetadata(currentView.private_metadata);

        await client.views.update({
          view_id: currentView.id,
          hash: currentView.hash,
          view: buildJummahScheduleView(
            current,
            metadata.responseUrl,
          ),
        });

        logInfo("jummah_schedule_form_opened", {
          slackUserId: body.user.id,
        });
      } catch (error) {
        logError("jummah_schedule_form_open_failed", error, {
          slackUserId: body.user.id,
        });
      }
    };

    if (options.scheduleBackgroundTask) {
      options.scheduleBackgroundTask(showScheduleForm());
      return;
    }

    await showScheduleForm();
  });

  app.action(
    "select_event_to_edit",
    async ({ ack, action, body, client }) => {
      await ack();

      if (!allowedSlackUserIds.has(body.user.id)) {
        logWarning("slack_authorization_denied", {
          slackUserId: body.user.id,
          action: "select_event_to_edit",
        });
        return;
      }

      const selectedOption =
        "selected_option" in action ? action.selected_option : undefined;
      const selectedEventId = selectedOption?.value;
      const currentView = "view" in body ? body.view : undefined;

      if (!selectedEventId || !currentView) {
        logWarning("event_selection_missing_context", {
          slackUserId: body.user.id,
        });
        return;
      }

      const loadEditForm = async () => {
        try {
          const event = await contentService.getManageableEvent(
            selectedEventId,
          );

          if (!event) {
            throw new Error("The selected event no longer exists.");
          }

          const existingMetadata = parseEditViewMetadata(
            currentView.private_metadata,
          );

          await client.views.update({
            view_id: currentView.id,
            hash: currentView.hash,
            view: {
              type: "modal",
              callback_id: "edit_event",
              private_metadata: JSON.stringify({
                eventId: event.id,
                responseUrl: existingMetadata.responseUrl,
              }),
              title: {
                type: "plain_text",
                text: "Edit Event",
              },
              submit: {
                type: "plain_text",
                text: "Save",
              },
              close: {
                type: "plain_text",
                text: "Cancel",
              },
              blocks: [
                {
                  type: "input",
                  block_id: "edit_event_title",
                  label: {
                    type: "plain_text",
                    text: "Title",
                  },
                  element: {
                    type: "plain_text_input",
                    action_id: "title_input",
                    initial_value: event.title,
                  },
                },
                {
                  type: "input",
                  block_id: "edit_event_description",
                  label: {
                    type: "plain_text",
                    text: "Description",
                  },
                  element: {
                    type: "plain_text_input",
                    action_id: "description_input",
                    initial_value: event.description,
                    multiline: true,
                  },
                },
                {
                  type: "input",
                  block_id: "edit_event_date",
                  label: {
                    type: "plain_text",
                    text: "Event date",
                  },
                  element: {
                    type: "datepicker",
                    action_id: "event_date_input",
                    initial_date: event.eventDate,
                  },
                },
                {
                  type: "input",
                  block_id: "edit_start_time",
                  label: {
                    type: "plain_text",
                    text: "Start time",
                  },
                  element: {
                    type: "timepicker",
                    action_id: "start_time_input",
                    ...(event.startTime
                      ? { initial_time: event.startTime }
                      : {}),
                  },
                },
                {
                  type: "input",
                  block_id: "edit_end_time",
                  label: {
                    type: "plain_text",
                    text: "End time",
                  },
                  element: {
                    type: "timepicker",
                    action_id: "end_time_input",
                    ...(event.endTime ? { initial_time: event.endTime } : {}),
                  },
                },
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `*Images:* ${event.imageUrls.length} existing image(s) will be preserved.`,
                  },
                },
                {
                  type: "input",
                  block_id: "edit_event_images",
                  optional: true,
                  label: {
                    type: "plain_text",
                    text: "Replace images (optional)",
                  },
                  hint: {
                    type: "plain_text",
                    text: "Leave empty to keep the existing images.",
                  },
                  element: {
                    type: "file_input",
                    action_id: "images_input",
                    filetypes: ["jpg", "jpeg", "png", "webp"],
                    max_files: 5,
                  },
                },
                {
                  type: "actions",
                  block_id: "event_actions",
                  elements: [
                    {
                      type: "button",
                      action_id: "delete_event",
                      text: {
                        type: "plain_text",
                        text: "Delete event",
                      },
                      style: "danger",
                      value: event.id,
                      confirm: {
                        title: {
                          type: "plain_text",
                          text: "Delete event?",
                        },
                        text: {
                          type: "mrkdwn",
                          text: "This permanently deletes the event and its images.",
                        },
                        confirm: {
                          type: "plain_text",
                          text: "Delete",
                        },
                        deny: {
                          type: "plain_text",
                          text: "Cancel",
                        },
                      },
                    },
                  ],
                },
              ],
            },
          });

          logInfo("event_edit_form_opened", {
            eventId: event.id,
            slackUserId: body.user.id,
          });
        } catch (error) {
          logError("event_edit_form_open_failed", error, {
            eventId: selectedEventId,
            slackUserId: body.user.id,
          });
        }
      };

      if (options.scheduleBackgroundTask) {
        options.scheduleBackgroundTask(loadEditForm());
        return;
      }

      await loadEditForm();
    },
  );

  app.view("create_event", async ({ ack, body, client, view }) => {
    if (!allowedSlackUserIds.has(body.user.id)) {
      await ack({
        response_action: "errors",
        errors: {
          event_title: "You are not authorized to create events.",
        },
      });

      logWarning("slack_authorization_denied", {
        slackUserId: body.user.id,
        action: "create_event",
        slackSubmissionId: view.id,
      });

      const notifyAdministrators = sendSlackLog(
        client,
        logChannelId,
        [
          "⚠️ Unauthorized event submission rejected",
          `User ID: ${body.user.id}`,
          `Submission ID: ${view.id}`,
        ].join("\n"),
        {
          slackUserId: body.user.id,
          slackSubmissionId: view.id,
        },
      );

      if (options.scheduleBackgroundTask) {
        options.scheduleBackgroundTask(notifyAdministrators);
      } else {
        await notifyAdministrators;
      }

      return;
    }

    const values = view.state.values;

    const title = values.event_title?.title_input?.value;
    const description = values.event_description?.description_input?.value;
    const eventDate = values.event_date?.event_date_input?.selected_date;
    const startTime = values.start_time?.start_time_input?.selected_time;
    const endTime = values.end_time?.end_time_input?.selected_time;
    const files = values.event_images?.images_input?.files ?? [];

    const errors: Record<string, string> = {};

    if (!title?.trim()) {
      errors.event_title = "Enter an event title.";
    }
    if (!description?.trim()) {
      errors.event_description = "Enter an event description.";
    }
    if (!eventDate) {
      errors.event_date = "Choose an event date.";
    }
    if (!startTime) {
      errors.start_time = "Choose a start time.";
    }
    if (!endTime) {
      errors.end_time = "Choose an end time.";
    }
    if (startTime && endTime && endTime <= startTime) {
      errors.end_time = "End time must be after the start time.";
    }
    if (files.length < 1 || files.length > 5) {
      errors.event_images = "Upload between one and five images.";
    }

    if (Object.keys(errors).length > 0) {
      logWarning("event_submission_validation_failed", {
        slackSubmissionId: view.id,
        slackUserId: body.user.id,
        invalidFields: Object.keys(errors),
      });

      await ack({
        response_action: "errors",
        errors,
      });
      return;
    }

    await ack();

    // The checks above narrow these values for our domain model.
    if (!title || !description || !eventDate || !startTime || !endTime) {
      return;
    }

    const draft: EventDraft = {
      type: "event",
      title,
      description,
      eventDate,
      startTime,
      endTime,
      slackSubmissionId: view.id,
      createdBySlackUserId: body.user.id,
    };

    const saveEvent = async () => {
      const startedAt = Date.now();
      let failureStage = "slack_image_download";

      logInfo("event_submission_received", {
        slackSubmissionId: view.id,
        slackUserId: body.user.id,
        imageCount: files.length,
      });

      try {
        const imageUploads = await downloadSlackImages(files, botToken);
        logInfo("slack_images_downloaded", {
          slackSubmissionId: view.id,
          imageCount: imageUploads.length,
        });

        failureStage = "event_creation";
        const result = await contentService.createEvent(draft, imageUploads);
        const { event } = result;

        if (result.created) {
          logInfo("event_created", {
            eventId: event.id,
            slackSubmissionId: event.slackSubmissionId,
            slackUserId: event.createdBySlackUserId,
            imageCount: event.imageUrls.length,
            durationMs: Date.now() - startedAt,
          });

          await sendSlackLog(
            client,
            logChannelId,
            [
              "✅ Event created",
              `Title: ${event.title}`,
              `Date: ${event.eventDate}`,
              `Time: ${event.startTime}–${event.endTime}`,
              `Submitted by: <@${event.createdBySlackUserId}>`,
              `Images: ${event.imageUrls.length}`,
              `Event ID: ${event.id}`,
            ].join("\n"),
            {
              eventId: event.id,
              slackSubmissionId: event.slackSubmissionId,
            },
          );

          await cleanupStaleEvents(
            client,
            "event_saved",
            body.user.id,
          );
        } else {
          logInfo("duplicate_event_submission_ignored", {
            eventId: event.id,
            slackSubmissionId: event.slackSubmissionId,
            slackUserId: body.user.id,
            durationMs: Date.now() - startedAt,
          });
        }

        const metadata = JSON.parse(view.private_metadata) as {
          responseUrl?: string;
        };
        if (metadata.responseUrl) {
          try {
            await sendCommandResponse(
              metadata.responseUrl,
              `Event “${event.title}” was saved with ${event.imageUrls.length} image(s).`,
            );
          } catch (responseError) {
            logError("slack_success_response_failed", responseError, {
              eventId: event.id,
              slackSubmissionId: event.slackSubmissionId,
            });
          }
        }
      } catch (error) {
        if (error instanceof EventCreationError) {
          failureStage = error.stage;
        }

        logError("event_creation_failed", error, {
          slackSubmissionId: view.id,
          slackUserId: body.user.id,
          stage: failureStage,
          durationMs: Date.now() - startedAt,
        });

        await sendSlackLog(
          client,
          logChannelId,
          [
            "❌ Event creation failed",
            `Submitted by: <@${body.user.id}>`,
            `Stage: ${failureStage}`,
            `Submission ID: ${view.id}`,
          ].join("\n"),
          {
            slackSubmissionId: view.id,
            stage: failureStage,
          },
        );

        try {
          const metadata = JSON.parse(view.private_metadata) as {
            responseUrl?: string;
          };
          if (metadata.responseUrl) {
            await sendCommandResponse(
              metadata.responseUrl,
              "The event could not be saved. Check the application logs and try again.",
            );
          }
        } catch (responseError) {
          logError("slack_submission_response_failed", responseError, {
            slackSubmissionId: view.id,
          });
        }
      }
    };

    if (options.scheduleBackgroundTask) {
      options.scheduleBackgroundTask(saveEvent());
      return;
    }

    await saveEvent();
  });

  app.view("update_jummah", async ({ ack, body, client, view }) => {
    if (!allowedSlackUserIds.has(body.user.id)) {
      await ack({
        response_action: "errors",
        errors: {
          first_start_time: "You are not authorized to update Jummah information.",
        },
      });

      logWarning("slack_authorization_denied", {
        slackUserId: body.user.id,
        action: "update_jummah",
      });
      return;
    }

    const values = view.state.values;
    const firstStartTime =
      values.first_start_time?.time_input?.selected_time;
    const firstEndTime = values.first_end_time?.time_input?.selected_time;
    const firstLocation =
      values.first_location?.location_input?.value?.trim();
    const secondStartTime =
      values.second_start_time?.time_input?.selected_time || null;
    const secondEndTime =
      values.second_end_time?.time_input?.selected_time || null;
    const secondLocation =
      values.second_location?.location_input?.value?.trim() || null;
    const errors: Record<string, string> = {};

    if (!firstStartTime) {
      errors.first_start_time = "Enter the first Jummah start time.";
    }
    if (!firstEndTime) {
      errors.first_end_time = "Enter the first Jummah end time.";
    }
    if (!firstLocation) {
      errors.first_location = "Enter the first Jummah location.";
    }
    if (
      firstStartTime &&
      firstEndTime &&
      firstEndTime <= firstStartTime
    ) {
      errors.first_end_time = "End time must be after the start time.";
    }
    if (Boolean(secondStartTime) !== Boolean(secondEndTime)) {
      if (!secondStartTime) {
        errors.second_start_time =
          "Enter both second Jummah times or leave both empty.";
      }
      if (!secondEndTime) {
        errors.second_end_time =
          "Enter both second Jummah times or leave both empty.";
      }
    }
    if (secondLocation && !secondStartTime && !secondEndTime) {
      errors.second_start_time =
        "Enter second Jummah start and end times when providing its location.";
    }
    if (
      secondStartTime &&
      secondEndTime &&
      secondEndTime <= secondStartTime
    ) {
      errors.second_end_time = "End time must be after the start time.";
    }

    if (Object.keys(errors).length > 0) {
      logWarning("jummah_submission_validation_failed", {
        slackUserId: body.user.id,
        invalidFields: Object.keys(errors),
      });
      await ack({
        response_action: "errors",
        errors,
      });
      return;
    }

    await ack();

    if (!firstStartTime || !firstEndTime || !firstLocation) {
      return;
    }

    const saveJummah = async () => {
      try {
        const jummah = await jummahService.save({
          firstStartTime,
          firstEndTime,
          firstLocation,
          secondStartTime,
          secondEndTime,
          secondLocation,
          updatedBySlackUserId: body.user.id,
        });

        logInfo("jummah_updated", {
          slackUserId: body.user.id,
          hasSecondJummah: Boolean(jummah.secondStartTime),
        });

        await sendSlackLog(
          client,
          logChannelId,
          [
            "🕌 Jummah information updated",
            `First: ${jummah.firstStartTime}–${jummah.firstEndTime}`,
            `First location: ${jummah.firstLocation}`,
            jummah.secondStartTime &&
            jummah.secondEndTime &&
            jummah.secondLocation
              ? `Second: ${jummah.secondStartTime}–${jummah.secondEndTime}\nSecond location: ${jummah.secondLocation}`
              : "Second: N/A",
            `Updated by: <@${body.user.id}>`,
          ].join("\n"),
          {
            slackUserId: body.user.id,
            hasSecondJummah: Boolean(jummah.secondStartTime),
          },
        );

        const metadata = parseEditViewMetadata(view.private_metadata);
        if (metadata.responseUrl) {
          await sendCommandResponse(
            metadata.responseUrl,
            "Jummah information was saved.",
          ).catch((error) =>
            logError("slack_jummah_response_failed", error, {
              slackUserId: body.user.id,
            }),
          );
        }
      } catch (error) {
        logError("jummah_update_failed", error, {
          slackUserId: body.user.id,
        });

        await sendSlackLog(
          client,
          logChannelId,
          [
            "❌ Jummah update failed",
            `Attempted by: <@${body.user.id}>`,
          ].join("\n"),
          {
            slackUserId: body.user.id,
          },
        );

        const metadata = parseEditViewMetadata(view.private_metadata);
        if (metadata.responseUrl) {
          await sendCommandResponse(
            metadata.responseUrl,
            "Jummah information could not be saved. Check the application logs and try again.",
          ).catch((responseError) =>
            logError("slack_jummah_error_response_failed", responseError, {
              slackUserId: body.user.id,
            }),
          );
        }
      }
    };

    if (options.scheduleBackgroundTask) {
      options.scheduleBackgroundTask(saveJummah());
      return;
    }

    await saveJummah();
  });

  app.view(
    "update_jummah_unavailable",
    async ({ ack, body, client, view }) => {
      if (!allowedSlackUserIds.has(body.user.id)) {
        await ack({
          response_action: "errors",
          errors: {
            unavailable_message:
              "You are not authorized to update Jummah information.",
          },
        });

        logWarning("slack_authorization_denied", {
          slackUserId: body.user.id,
          action: "update_jummah_unavailable",
        });
        return;
      }

      const unavailableMessage =
        view.state.values.unavailable_message?.message_input?.value?.trim();

      if (!unavailableMessage) {
        await ack({
          response_action: "errors",
          errors: {
            unavailable_message: "Enter a message for the website.",
          },
        });
        return;
      }

      await ack();

      const markJummahUnavailable = async () => {
        try {
          const jummah = await jummahService.markUnavailable({
            unavailableMessage,
            updatedBySlackUserId: body.user.id,
          });

          logInfo("jummah_marked_unavailable", {
            slackUserId: body.user.id,
          });

          await sendSlackLog(
            client,
            logChannelId,
            [
              "🚫 Jummah marked unavailable",
              `Message: ${jummah.unavailableMessage}`,
              `Updated by: <@${body.user.id}>`,
            ].join("\n"),
            {
              slackUserId: body.user.id,
            },
          );

          const metadata = parseEditViewMetadata(view.private_metadata);
          if (metadata.responseUrl) {
            await sendCommandResponse(
              metadata.responseUrl,
              "Jummah was marked as unavailable.",
            ).catch((error) =>
              logError("slack_jummah_response_failed", error, {
                slackUserId: body.user.id,
              }),
            );
          }
        } catch (error) {
          logError("jummah_unavailable_update_failed", error, {
            slackUserId: body.user.id,
          });

          await sendSlackLog(
            client,
            logChannelId,
            [
              "❌ Jummah availability update failed",
              `Attempted by: <@${body.user.id}>`,
            ].join("\n"),
            {
              slackUserId: body.user.id,
            },
          );

          const metadata = parseEditViewMetadata(view.private_metadata);
          if (metadata.responseUrl) {
            await sendCommandResponse(
              metadata.responseUrl,
              "Jummah availability could not be saved. Check the application logs and try again.",
            ).catch((responseError) =>
              logError(
                "slack_jummah_error_response_failed",
                responseError,
                {
                  slackUserId: body.user.id,
                },
              ),
            );
          }
        }
      };

      if (options.scheduleBackgroundTask) {
        options.scheduleBackgroundTask(markJummahUnavailable());
        return;
      }

      await markJummahUnavailable();
    },
  );

  app.view("edit_event", async ({ ack, body, client, view }) => {
    if (!allowedSlackUserIds.has(body.user.id)) {
      await ack({
        response_action: "errors",
        errors: {
          edit_event_title: "You are not authorized to edit events.",
        },
      });
      logWarning("slack_authorization_denied", {
        slackUserId: body.user.id,
        action: "edit_event",
      });
      return;
    }

    const metadata = parseEditViewMetadata(view.private_metadata);
    const values = view.state.values;
    const title = values.edit_event_title?.title_input?.value;
    const description =
      values.edit_event_description?.description_input?.value;
    const eventDate =
      values.edit_event_date?.event_date_input?.selected_date;
    const startTime =
      values.edit_start_time?.start_time_input?.selected_time;
    const endTime = values.edit_end_time?.end_time_input?.selected_time;
    const replacementFiles =
      values.edit_event_images?.images_input?.files ?? [];
    const errors: Record<string, string> = {};

    if (!metadata.eventId) {
      errors.edit_event_title = "This event could not be identified.";
    }
    if (!title?.trim()) {
      errors.edit_event_title = "Enter an event title.";
    }
    if (!description?.trim()) {
      errors.edit_event_description = "Enter an event description.";
    }
    if (!eventDate) {
      errors.edit_event_date = "Choose an event date.";
    }
    if (!startTime) {
      errors.edit_start_time = "Choose a start time.";
    }
    if (!endTime) {
      errors.edit_end_time = "Choose an end time.";
    }
    if (startTime && endTime && endTime <= startTime) {
      errors.edit_end_time = "End time must be after the start time.";
    }
    if (replacementFiles.length > 5) {
      errors.edit_event_images = "Upload no more than five replacement images.";
    }

    if (Object.keys(errors).length > 0) {
      logWarning("event_edit_validation_failed", {
        eventId: metadata.eventId,
        slackUserId: body.user.id,
        invalidFields: Object.keys(errors),
      });
      await ack({
        response_action: "errors",
        errors,
      });
      return;
    }

    await ack();

    if (
      !metadata.eventId ||
      !title ||
      !description ||
      !eventDate ||
      !startTime ||
      !endTime
    ) {
      return;
    }

    const changes: EventUpdate = {
      title,
      description,
      eventDate,
      startTime,
      endTime,
    };

    const saveChanges = async () => {
      let failureStage =
        replacementFiles.length > 0
          ? "slack_image_download"
          : "database_update";

      try {
        const replacementUploads =
          replacementFiles.length > 0
            ? await downloadSlackImages(replacementFiles, botToken)
            : [];

        if (replacementUploads.length > 0) {
          logInfo("replacement_images_downloaded", {
            eventId: metadata.eventId,
            imageCount: replacementUploads.length,
          });
        }

        failureStage = "event_update";
        const result = await contentService.updateEvent(
          metadata.eventId as string,
          changes,
          replacementUploads,
        );

        if (!result) {
          throw new Error("The event no longer exists.");
        }

        const { event } = result;

        logInfo("event_updated", {
          eventId: event.id,
          slackUserId: body.user.id,
          imagesReplaced: result.imagesReplaced,
          imageCount: event.imageUrls.length,
          oldImageCleanupSucceeded: result.oldImageCleanupSucceeded,
        });

        if (!result.oldImageCleanupSucceeded) {
          logWarning("replaced_event_blob_cleanup_failed", {
            eventId: event.id,
          });
        }

        await sendSlackLog(
          client,
          logChannelId,
          [
            "✏️ Event updated",
            `Title: ${event.title}`,
            `Date: ${event.eventDate}`,
            `Time: ${event.startTime}–${event.endTime}`,
            `Updated by: <@${body.user.id}>`,
            result.imagesReplaced
              ? `Replacement images: ${event.imageUrls.length}`
              : `Images preserved: ${event.imageUrls.length}`,
            result.oldImageCleanupSucceeded
              ? "Old-image cleanup: complete"
              : "⚠️ Some replaced Blob images may require manual cleanup.",
            `Event ID: ${event.id}`,
          ].join("\n"),
          {
            eventId: event.id,
            slackUserId: body.user.id,
          },
        );

        await cleanupStaleEvents(
          client,
          "event_edited",
          body.user.id,
        );

        if (metadata.responseUrl) {
          await sendCommandResponse(
            metadata.responseUrl,
            `Event “${event.title}” was updated.`,
          ).catch((error) =>
            logError("slack_edit_response_failed", error, {
              eventId: event.id,
            }),
          );
        }
      } catch (error) {
        if (error instanceof EventUpdateError) {
          failureStage = error.stage;
        }

        logError("event_update_failed", error, {
          eventId: metadata.eventId,
          slackUserId: body.user.id,
          stage: failureStage,
        });

        await sendSlackLog(
          client,
          logChannelId,
          [
            "❌ Event update failed",
            `Event ID: ${metadata.eventId}`,
            `Attempted by: <@${body.user.id}>`,
            `Stage: ${failureStage}`,
          ].join("\n"),
          {
            eventId: metadata.eventId,
            slackUserId: body.user.id,
          },
        );

        if (metadata.responseUrl) {
          await sendCommandResponse(
            metadata.responseUrl,
            "The event could not be updated. Check the application logs and try again.",
          ).catch((responseError) =>
            logError("slack_edit_error_response_failed", responseError, {
              eventId: metadata.eventId,
            }),
          );
        }
      }
    };

    if (options.scheduleBackgroundTask) {
      options.scheduleBackgroundTask(saveChanges());
      return;
    }

    await saveChanges();
  });

  app.action("delete_event", async ({ ack, action, body, client }) => {
    await ack();

    if (!allowedSlackUserIds.has(body.user.id)) {
      logWarning("slack_authorization_denied", {
        slackUserId: body.user.id,
        action: "delete_event",
      });
      return;
    }

    const eventId = "value" in action ? action.value : undefined;
    const currentView = "view" in body ? body.view : undefined;

    if (!eventId || !currentView) {
      logWarning("event_delete_missing_context", {
        slackUserId: body.user.id,
      });
      return;
    }

    const metadata = parseEditViewMetadata(currentView.private_metadata);

    const deleteEvent = async () => {
      try {
        const result = await contentService.deleteEvent(eventId);

        if (!result) {
          throw new Error("The event no longer exists.");
        }

        logInfo("event_deleted", {
          eventId: result.event.id,
          slackUserId: body.user.id,
          imageCount: result.event.imageUrls.length,
          blobCleanupSucceeded: result.blobCleanupSucceeded,
        });

        if (!result.blobCleanupSucceeded) {
          logWarning("event_blob_cleanup_failed", {
            eventId: result.event.id,
            imageCount: result.event.imageUrls.length,
          });
        }

        await sendSlackLog(
          client,
          logChannelId,
          [
            "🗑️ Event deleted",
            `Title: ${result.event.title}`,
            `Deleted by: <@${body.user.id}>`,
            `Event ID: ${result.event.id}`,
            result.blobCleanupSucceeded
              ? `Images deleted: ${result.event.imageUrls.length}`
              : "⚠️ Some Blob images may require manual cleanup.",
          ].join("\n"),
          {
            eventId: result.event.id,
            slackUserId: body.user.id,
          },
        );

        await client.views.update({
          view_id: currentView.id,
          view: {
            type: "modal",
            callback_id: "event_deleted",
            title: {
              type: "plain_text",
              text: "Event Deleted",
            },
            close: {
              type: "plain_text",
              text: "Close",
            },
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `✅ *${result.event.title}* was deleted.`,
                },
              },
            ],
          },
        });

        if (metadata.responseUrl) {
          await sendCommandResponse(
            metadata.responseUrl,
            `Event “${result.event.title}” was deleted.`,
          ).catch((error) =>
            logError("slack_delete_response_failed", error, {
              eventId: result.event.id,
            }),
          );
        }
      } catch (error) {
        logError("event_delete_failed", error, {
          eventId,
          slackUserId: body.user.id,
        });

        await sendSlackLog(
          client,
          logChannelId,
          [
            "❌ Event deletion failed",
            `Event ID: ${eventId}`,
            `Attempted by: <@${body.user.id}>`,
          ].join("\n"),
          {
            eventId,
            slackUserId: body.user.id,
          },
        );

        await client.views
          .update({
            view_id: currentView.id,
            view: {
              type: "modal",
              callback_id: "event_delete_failed",
              title: {
                type: "plain_text",
                text: "Delete Failed",
              },
              close: {
                type: "plain_text",
                text: "Close",
              },
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: "The event could not be deleted. Check the application logs and try again.",
                  },
                },
              ],
            },
          })
          .catch((viewError) =>
            logError("delete_failure_view_update_failed", viewError, {
              eventId,
            }),
          );
      }
    };

    if (options.scheduleBackgroundTask) {
      options.scheduleBackgroundTask(deleteEvent());
      return;
    }

    await deleteEvent();
  });

  return app;
}
