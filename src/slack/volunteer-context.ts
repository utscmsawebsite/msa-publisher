import type { App } from "@slack/bolt";

export type SlackClient = App["client"];

export interface VolunteerSlackContext {
  app: App;
  background: (name: string, task: () => Promise<void>) => Promise<void>;
  opsLog: (client: SlackClient, text: string) => Promise<void>;
  sendDirectMessage: (
    client: SlackClient,
    slackUserId: string,
    text: string,
  ) => Promise<boolean>;
}

export const ACK_BUDGET_MS = 2300;

export async function settleWithin<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<{ settled: true; value: T } | { settled: false }> {
  // Marks the promise as handled so a rejection that lands after the budget
  // can't surface as an unhandled rejection before the caller awaits it.
  promise.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), milliseconds);
  });

  try {
    return await Promise.race([
      promise.then((value) => ({ settled: true as const, value })),
      timeout,
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
