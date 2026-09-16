import type { IncomingMessage, ServerResponse } from "node:http";
import { HTTPReceiver } from "@slack/bolt";
import { waitUntil } from "@vercel/functions";
import {
  createContentService,
  createJummahService,
  requireEnvironmentVariable,
} from "../src/application.js";
import { createSlackApp } from "../src/slack/bolt.js";

const receiver = new HTTPReceiver({
  signingSecret: requireEnvironmentVariable("SLACK_SIGNING_SECRET"),
  endpoints: "/api/slack",
  processBeforeResponse: false,
});

createSlackApp(createContentService(), createJummahService(), {
  receiver,
  scheduleBackgroundTask: waitUntil,
});

export default function handler(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  receiver.requestListener(request, response);
}
