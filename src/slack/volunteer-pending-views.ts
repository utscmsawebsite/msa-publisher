import type { VolunteerSubmission } from "../domain/volunteer.js";
import { hubBackBlock, type HubBack } from "./volunteer-hub-views.js";
import { datesLine } from "./volunteer-request-views.js";
import {
  actionIds,
  decisionValue,
  escapeSlackText,
  formatHours,
  submittedDate,
  totalHours,
  truncate,
  type Block,
  type ModalView,
} from "./volunteer-views.js";

/**
 * The approvers' queue: every request waiting for a decision, oldest first,
 * each with Approve and Disapprove buttons. It does the same job as the cards
 * in the approvals channel, from one place.
 */
export function pendingCardText(request: VolunteerSubmission): string {
  const where = request.eventName
    ? `${request.categoryName}: ${request.eventName}`
    : request.categoryName;
  const edited = request.editedBySlackUserId ? "  ·  ✏️ edited" : "";

  return [
    `*${escapeSlackText(truncate(request.volunteerName, 60))}*  ·  *${datesLine(request)}*  ·  *${formatHours(totalHours(request))} h*`,
    escapeSlackText(truncate(where, 80)),
    `_${escapeSlackText(truncate(request.description, 160))}_`,
    `Submitted ${submittedDate(request)}${edited}`,
  ].join("\n");
}

export interface PendingScreen {
  requests: VolunteerSubmission[];
  /** How many are waiting in all (the screen shows the oldest few). */
  total: number;
  /** Only staff who can approve get the buttons. */
  canApprove: boolean;
  notice?: string | null;
  back: HubBack;
}

export function buildPendingView(screen: PendingScreen): ModalView {
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
    text: {
      type: "mrkdwn",
      text:
        screen.total === 0
          ? "*Pending requests*\nNothing is waiting for review."
          : `*Pending requests*\n${screen.total} waiting, oldest first.`,
    },
  });

  if (!screen.canApprove && screen.total > 0) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "You can see the queue, but only staff with the approve permission can approve or disapprove.",
        },
      ],
    });
  }

  for (const request of screen.requests) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(pendingCardText(request), 2900) },
    });

    if (screen.canApprove) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: actionIds.approve,
            style: "primary",
            text: { type: "plain_text", text: "Approve" },
            value: decisionValue(request),
          },
          {
            type: "button",
            action_id: actionIds.disapprove,
            style: "danger",
            text: { type: "plain_text", text: "Disapprove" },
            value: decisionValue(request),
          },
        ],
      });
    }
  }

  if (screen.total > screen.requests.length) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Showing the oldest ${screen.requests.length} of ${screen.total}. The rest appear as you clear these.`,
        },
      ],
    });
  }

  return {
    type: "modal",
    title: { type: "plain_text", text: "Pending requests" },
    close: { type: "plain_text", text: "Close" },
    blocks: blocks.slice(0, 100),
  };
}
