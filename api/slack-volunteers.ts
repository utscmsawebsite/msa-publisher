import type { IncomingMessage, ServerResponse } from "node:http";
import { HTTPReceiver } from "@slack/bolt";
import { waitUntil } from "@vercel/functions";
import {
  createVolunteerServices,
  requireEnvironmentVariable,
} from "../src/volunteer-application.js";
import { createVolunteerSlackApp } from "../src/slack/volunteer-app.js";

const receiver = new HTTPReceiver({
  signingSecret: requireEnvironmentVariable("SLACK_VOLUNTEER_SIGNING_SECRET"),
  endpoints: "/api/slack-volunteers",
  processBeforeResponse: false,
});

createVolunteerSlackApp(createVolunteerServices(), {
  receiver,
  scheduleBackgroundTask: waitUntil,
});

export default function handler(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  receiver.requestListener(request, response);
}
