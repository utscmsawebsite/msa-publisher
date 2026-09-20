import { neon } from "@neondatabase/serverless";
import type {
  CalendarRepository,
  JummahCalendarIds,
} from "./calendar.repository.js";

export class NeonCalendarRepository implements CalendarRepository {
  private readonly sql;

  constructor(databaseUrl: string) {
    this.sql = neon(databaseUrl);
  }

  async getEventCalendarId(eventId: string): Promise<string | null> {
    const rows = await this.sql`
      SELECT google_calendar_event_id AS "googleCalendarEventId"
      FROM events
      WHERE id = ${eventId}
      LIMIT 1
    `;

    const row = rows[0];
    return row ? (row.googleCalendarEventId as string | null) : null;
  }

  async setEventCalendarId(
    eventId: string,
    calendarEventId: string | null,
  ): Promise<void> {
    await this.sql`
      UPDATE events
      SET google_calendar_event_id = ${calendarEventId}
      WHERE id = ${eventId}
    `;
  }

  async getJummahCalendarIds(): Promise<JummahCalendarIds> {
    const rows = await this.sql`
      SELECT
        google_calendar_first_event_id AS "first",
        google_calendar_second_event_id AS "second"
      FROM jummah
      WHERE id = 'current'
      LIMIT 1
    `;

    const row = rows[0];
    return {
      first: row ? (row.first as string | null) : null,
      second: row ? (row.second as string | null) : null,
    };
  }

  async setJummahCalendarIds(ids: JummahCalendarIds): Promise<void> {
    await this.sql`
      UPDATE jummah
      SET
        google_calendar_first_event_id = ${ids.first},
        google_calendar_second_event_id = ${ids.second}
      WHERE id = 'current'
    `;
  }
}
