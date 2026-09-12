import { App } from "@slack/bolt";
import type { Receiver } from "@slack/bolt";
import type { EventDraft } from "../domain/content.js";
import type { ContentService } from "../services/content.service.js";
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

export function createSlackApp(
  contentService: ContentService,
  options: SlackAppOptions = {},
): App {
  const botToken = process.env.SLACK_BOT_TOKEN;

  if (!botToken) {
    throw new Error(
      "SLACK_BOT_TOKEN must be defined in the environment variables.",
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

  app.command("/event", async ({ ack, command, client, logger, respond }) => {
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
                block_id: "publish_date",
                optional: true,
                label: {
                  type: "plain_text",
                  text: "Publish date (optional)",
                },
                element: {
                  type: "datepicker",
                  action_id: "publish_date_input",
                },
              },
              {
                type: "input",
                block_id: "publish_time",
                optional: true,
                label: {
                  type: "plain_text",
                  text: "Publish time (optional)",
                },
                element: {
                  type: "timepicker",
                  action_id: "publish_time_input",
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
        logger.error(error);
        await respond("Sorry, the event form could not be opened.");
      }
    };

    if (options.scheduleBackgroundTask) {
      options.scheduleBackgroundTask(openEventForm());
      return;
    }

    await openEventForm();
  });

  app.view("create_event", async ({ ack, body, view, logger }) => {
    const values = view.state.values;

    const title = values.event_title?.title_input?.value;
    const description = values.event_description?.description_input?.value;
    const publishDate =
      values.publish_date?.publish_date_input?.selected_date ?? null;
    const publishTime =
      values.publish_time?.publish_time_input?.selected_time ?? null;
    const eventDate = values.event_date?.event_date_input?.selected_date;
    const files = values.event_images?.images_input?.files ?? [];

    const errors: Record<string, string> = {};

    if (!title?.trim()) {
      errors.event_title = "Enter an event title.";
    }
    if (!description?.trim()) {
      errors.event_description = "Enter an event description.";
    }
    if (publishDate && !publishTime) {
      errors.publish_time = "Choose a publish time or clear the publish date.";
    }
    if (publishTime && !publishDate) {
      errors.publish_date = "Choose a publish date or clear the publish time.";
    }
    if (!eventDate) {
      errors.event_date = "Choose an event date.";
    }
    if (files.length < 1 || files.length > 5) {
      errors.event_images = "Upload between one and five images.";
    }

    if (Object.keys(errors).length > 0) {
      await ack({
        response_action: "errors",
        errors,
      });
      return;
    }

    await ack();

    // The checks above narrow these values for our domain model.
    if (!title || !description || !eventDate) {
      return;
    }

    const draft: EventDraft = {
      type: "event",
      title,
      description,
      publishDate,
      publishTime,
      eventDate,
      createdBySlackUserId: body.user.id,
    };

    const saveEvent = async () => {
      try {
        const imageUploads = await downloadSlackImages(files, botToken);
        const event = await contentService.createEvent(draft, imageUploads);
        logger.info("Event created", event);

        const metadata = JSON.parse(view.private_metadata) as {
          responseUrl?: string;
        };
        if (metadata.responseUrl) {
          await sendCommandResponse(
            metadata.responseUrl,
            `Event “${event.title}” was saved with ${event.imageUrls.length} image(s).`,
          );
        }
      } catch (error) {
        logger.error("Failed to create event", error);

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
          logger.error("Failed to send event error response", responseError);
        }
      }
    };

    if (options.scheduleBackgroundTask) {
      options.scheduleBackgroundTask(saveEvent());
      return;
    }

    await saveEvent();
  });

  return app;
}
