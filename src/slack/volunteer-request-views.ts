import type { VolunteerSubmission } from "../domain/volunteer.js";
import { hubBackBlock, parseHubBack, type HubBack } from "./volunteer-hub-views.js";
import {
  actionIds,
  escapeSlackText,
  formatDate,
  formatHours,
  statusLabels,
  totalHours,
  truncate,
  type Block,
  type ModalView,
} from "./volunteer-views.js";

/**
 * A list of volunteer requests as cards, one per request, each with an Edit
 * button. It is the same screen for a volunteer's own My hours and for an
 * admin looking a volunteer up, so both work the same way.
 */
export const MAX_REQUEST_CARDS = 40;

export function isLocked(request: VolunteerSubmission): boolean {
  return request.entries.some((entry) => entry.ccrSentAt !== null);
}

/** What an Edit button carries: the request, and where its form's Back leads. */
export function requestEditValue(submissionId: string, back: HubBack): string {
  return `${submissionId}|${back}`;
}

export function parseRequestEditValue(value: string): {
  submissionId: string;
  back: HubBack;
} {
  const separator = value.indexOf("|");

  return separator < 0
    ? { submissionId: value, back: "member" }
    : {
        submissionId: value.slice(0, separator),
        back: parseHubBack(value.slice(separator + 1)),
      };
}

export function datesLine(request: VolunteerSubmission): string {
  const dates = request.entries.map((entry) => entry.entryDate);
  const first = dates[0];
  const last = dates.at(-1);

  if (!first || !last) {
    return "";
  }

  if (dates.length <= 3) {
    return dates.map(formatDate).join(", ");
  }

  return `${formatDate(first)} to ${formatDate(last)} (${dates.length} dates)`;
}

export function requestCardText(request: VolunteerSubmission): string {
  const where = request.eventName
    ? `${request.categoryName}: ${request.eventName}`
    : request.categoryName;
  const lines = [
    `*${datesLine(request)}*  ·  *${formatHours(totalHours(request))} h*  ·  ${statusLabels[request.status]}`,
    escapeSlackText(truncate(where, 80)),
    `_${escapeSlackText(truncate(request.description, 140))}_`,
  ];

  if (request.status === "rejected" && request.decisionNote) {
    lines.push(`↳ ${escapeSlackText(truncate(request.decisionNote, 160))}`);
  }

  if (request.submittedBySlackUserId !== request.volunteerSlackUserId) {
    lines.push("📝 Entered by staff");
  }

  if (isLocked(request)) {
    lines.push("🔒 Sent to CCR, so it can't be changed");
  }

  return lines.join("\n");
}

export interface RequestsScreen {
  title: string;
  /** The text at the top: the totals, and who they belong to. */
  heading: string;
  requests: VolunteerSubmission[];
  /** Where ← Back leads. */
  back: HubBack;
  /** What the edit form's ← Back should bring you back to (this screen). */
  editBack: HubBack;
  emptyText: string;
  notice?: string | null;
}

export function buildRequestsView(screen: RequestsScreen): ModalView {
  const shown = screen.requests.slice(0, MAX_REQUEST_CARDS);
  const blocks: Block[] = [hubBackBlock(screen.back)];

  if (screen.notice) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncate(
          screen.notice.startsWith("⚠️") ? screen.notice : `✅ ${screen.notice}`,
          2900,
        ),
      },
    });
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: truncate(screen.heading, 2900) },
  });

  if (shown.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(screen.emptyText, 2900) },
    });
  }

  for (const request of shown) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(requestCardText(request), 2900) },
      ...(isLocked(request)
        ? {}
        : {
            accessory: {
              type: "button" as const,
              action_id: actionIds.editRequest,
              text: { type: "plain_text" as const, text: "Edit" },
              value: requestEditValue(request.id, screen.editBack),
            },
          }),
    });
  }

  if (screen.requests.length > shown.length) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Showing ${shown.length} of ${screen.requests.length} requests.`,
        },
      ],
    });
  }

  return {
    type: "modal",
    title: { type: "plain_text", text: truncate(screen.title, 24) },
    close: { type: "plain_text", text: "Close" },
    blocks: blocks.slice(0, 100),
  };
}

/** The totals line used above a list of requests. */
export function requestTotals(requests: VolunteerSubmission[]): string {
  const sum = (status: VolunteerSubmission["status"]) =>
    formatHours(
      requests
        .filter((request) => request.status === status)
        .reduce((total, request) => total + totalHours(request), 0),
    );

  return `*Approved:* ${sum("approved")} h   *Pending:* ${sum("pending")} h   *Disapproved:* ${sum("rejected")} h`;
}
