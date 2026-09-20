import { createSign } from "node:crypto";
import type {
  CalendarAdapter,
  CalendarEventDetails,
} from "./calendar.adapter.js";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
const CALENDAR_TIME_ZONE = "America/Toronto";

interface CachedAccessToken {
  accessToken: string;
  expiresAtMs: number;
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlEncodeSignature(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function requestServiceAccountAccessToken(
  serviceAccountEmail: string,
  privateKey: string,
): Promise<CachedAccessToken> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 3600;

  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64UrlEncode(
    JSON.stringify({
      iss: serviceAccountEmail,
      scope: CALENDAR_SCOPE,
      aud: GOOGLE_TOKEN_ENDPOINT,
      iat: issuedAt,
      exp: expiresAt,
    }),
  );

  const signingInput = `${header}.${claims}`;
  const signature = base64UrlEncodeSignature(
    createSign("RSA-SHA256").update(signingInput).sign(privateKey),
  );

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${signingInput}.${signature}`,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Google Calendar authentication failed (${response.status}): ${await response.text()}`,
    );
  }

  const body = (await response.json()) as { access_token: string };

  return {
    accessToken: body.access_token,
    expiresAtMs: expiresAt * 1000,
  };
}

function toGoogleEventBody(details: CalendarEventDetails): Record<string, unknown> {
  return {
    summary: details.summary,
    ...(details.description !== undefined
      ? { description: details.description }
      : {}),
    ...(details.location !== undefined ? { location: details.location } : {}),
    start: { dateTime: details.startDateTime, timeZone: CALENDAR_TIME_ZONE },
    end: { dateTime: details.endDateTime, timeZone: CALENDAR_TIME_ZONE },
  };
}

export class GoogleCalendarAdapter implements CalendarAdapter {
  private cachedToken: CachedAccessToken | null = null;

  constructor(
    private readonly serviceAccountEmail: string,
    private readonly privateKey: string,
    private readonly calendarId: string,
  ) {}

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAtMs - 60_000 > Date.now()) {
      return this.cachedToken.accessToken;
    }

    this.cachedToken = await requestServiceAccountAccessToken(
      this.serviceAccountEmail,
      this.privateKey,
    );

    return this.cachedToken.accessToken;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}${path}`,
      {
        ...init,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Google Calendar API request failed (${response.status}): ${body}`,
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  async createEvent(details: CalendarEventDetails): Promise<string> {
    const created = await this.request<{ id: string }>("/events", {
      method: "POST",
      body: JSON.stringify(toGoogleEventBody(details)),
    });

    return created.id;
  }

  async updateEvent(
    eventId: string,
    details: CalendarEventDetails,
  ): Promise<void> {
    await this.request(`/events/${encodeURIComponent(eventId)}`, {
      method: "PATCH",
      body: JSON.stringify(toGoogleEventBody(details)),
    });
  }

  async deleteEvent(eventId: string): Promise<void> {
    try {
      await this.request(`/events/${encodeURIComponent(eventId)}`, {
        method: "DELETE",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("(404)") || message.includes("(410)")) {
        return;
      }
      throw error;
    }
  }

  async createWeeklyRecurringEvent(
    details: CalendarEventDetails,
  ): Promise<string> {
    const created = await this.request<{ id: string }>("/events", {
      method: "POST",
      body: JSON.stringify({
        ...toGoogleEventBody(details),
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=FR"],
      }),
    });

    return created.id;
  }

  async updateRecurringEvent(
    eventId: string,
    details: CalendarEventDetails,
  ): Promise<void> {
    await this.request(`/events/${encodeURIComponent(eventId)}`, {
      method: "PATCH",
      body: JSON.stringify(toGoogleEventBody(details)),
    });
  }

  async overrideNextOccurrence(
    recurringEventId: string,
    changes: { summary: string; description: string },
  ): Promise<void> {
    const instanceId = await this.findNextInstanceId(recurringEventId);

    if (!instanceId) {
      return;
    }

    await this.request(`/events/${encodeURIComponent(instanceId)}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    });
  }

  async cancelNextOccurrence(recurringEventId: string): Promise<void> {
    const instanceId = await this.findNextInstanceId(recurringEventId);

    if (!instanceId) {
      return;
    }

    await this.request(`/events/${encodeURIComponent(instanceId)}`, {
      method: "DELETE",
    });
  }

  private async findNextInstanceId(
    recurringEventId: string,
  ): Promise<string | null> {
    const timeMin = encodeURIComponent(new Date().toISOString());
    const result = await this.request<{ items: Array<{ id: string }> }>(
      `/events/${encodeURIComponent(recurringEventId)}/instances?timeMin=${timeMin}&maxResults=1`,
    );

    return result.items[0]?.id ?? null;
  }
}
