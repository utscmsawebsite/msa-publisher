import { neon } from "@neondatabase/serverless";
import type {
  Content,
  EventContent,
  EventUpdate,
  ManageableEvent,
  PublicEvent,
} from "../domain/content.js";
import type {
  ContentRepository,
  EventManagementRepository,
  EventQueryRepository,
} from "./content.repository.js";

type DatabaseRow = Record<string, unknown>;

function nullableTime(value: unknown): string | null {
  return value === null || value === undefined
    ? null
    : String(value).slice(0, 5);
}

function mapManageableEvent(row: DatabaseRow): ManageableEvent {
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description),
    eventDate: String(row.eventDate),
    startTime: nullableTime(row.startTime),
    endTime: nullableTime(row.endTime),
    imageUrls: Array.isArray(row.imageUrls)
      ? row.imageUrls.map((url) => String(url))
      : [],
    createdBySlackUserId: String(row.createdBySlackUserId),
  };
}

function mapEventContent(row: DatabaseRow): EventContent {
  const startTime = nullableTime(row.startTime);
  const endTime = nullableTime(row.endTime);

  if (!startTime || !endTime) {
    throw new Error("A saved event is missing its start or end time.");
  }

  return {
    type: "event",
    ...mapManageableEvent(row),
    startTime,
    endTime,
    slackSubmissionId: String(row.slackSubmissionId),
    createdAt: String(row.createdAt),
  };
}

export class NeonContentRepository
  implements ContentRepository, EventQueryRepository, EventManagementRepository
{
  private readonly sql;

  constructor(databaseUrl: string) {
    this.sql = neon(databaseUrl);
  }

  async save(content: Content): Promise<Content> {
    const rows = await this.sql`
      INSERT INTO events (
        id,
        title,
        description,
        event_date,
        start_time,
        end_time,
        image_urls,
        slack_submission_id,
        created_by_slack_user_id,
        created_at
      ) VALUES (
        ${content.id},
        ${content.title},
        ${content.description},
        ${content.eventDate},
        ${content.startTime},
        ${content.endTime},
        ${content.imageUrls},
        ${content.slackSubmissionId},
        ${content.createdBySlackUserId},
        ${content.createdAt}
      )
      ON CONFLICT (slack_submission_id) DO UPDATE
        SET slack_submission_id = EXCLUDED.slack_submission_id
      RETURNING
        id,
        title,
        description,
        event_date::text AS "eventDate",
        start_time::text AS "startTime",
        end_time::text AS "endTime",
        image_urls AS "imageUrls",
        slack_submission_id AS "slackSubmissionId",
        created_by_slack_user_id AS "createdBySlackUserId",
        created_at::text AS "createdAt"
    `;

    const saved = rows[0];

    if (!saved) {
      throw new Error("The event insert did not return a database record.");
    }

    return mapEventContent(saved);
  }

  async listVisibleEvents(): Promise<PublicEvent[]> {
    const rows = await this.sql`
      SELECT
        id,
        title,
        description,
        event_date::text AS "eventDate",
        start_time::text AS "startTime",
        end_time::text AS "endTime",
        image_urls AS "imageUrls"
      FROM events
      WHERE event_date >= (now() AT TIME ZONE 'America/Toronto')::date
      ORDER BY event_date ASC, start_time ASC, created_at ASC
    `;

    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      description: String(row.description),
      eventDate: String(row.eventDate),
      startTime:
        row.startTime === null ? null : String(row.startTime).slice(0, 5),
      endTime: row.endTime === null ? null : String(row.endTime).slice(0, 5),
      imageUrls: Array.isArray(row.imageUrls)
        ? row.imageUrls.map((url) => String(url))
        : [],
    }));
  }

  async listManageableEvents(): Promise<ManageableEvent[]> {
    const rows = await this.sql`
      SELECT
        id,
        title,
        description,
        event_date::text AS "eventDate",
        start_time::text AS "startTime",
        end_time::text AS "endTime",
        image_urls AS "imageUrls",
        created_by_slack_user_id AS "createdBySlackUserId"
      FROM events
      WHERE event_date >= (now() AT TIME ZONE 'America/Toronto')::date
      ORDER BY event_date ASC, start_time ASC NULLS LAST, created_at ASC
      LIMIT 100
    `;

    return rows.map(mapManageableEvent);
  }

  async findManageableEventById(id: string): Promise<ManageableEvent | null> {
    const rows = await this.sql`
      SELECT
        id,
        title,
        description,
        event_date::text AS "eventDate",
        start_time::text AS "startTime",
        end_time::text AS "endTime",
        image_urls AS "imageUrls",
        created_by_slack_user_id AS "createdBySlackUserId"
      FROM events
      WHERE id = ${id}
      LIMIT 1
    `;

    const event = rows[0];
    return event ? mapManageableEvent(event) : null;
  }

  async updateEvent(
    id: string,
    changes: EventUpdate,
    imageUrls?: string[],
  ): Promise<EventContent | null> {
    const rows = imageUrls
      ? await this.sql`
          UPDATE events
          SET
            title = ${changes.title},
            description = ${changes.description},
            event_date = ${changes.eventDate},
            start_time = ${changes.startTime},
            end_time = ${changes.endTime},
            image_urls = ${imageUrls}
          WHERE id = ${id}
          RETURNING
            id,
            title,
            description,
            event_date::text AS "eventDate",
            start_time::text AS "startTime",
            end_time::text AS "endTime",
            image_urls AS "imageUrls",
            slack_submission_id AS "slackSubmissionId",
            created_by_slack_user_id AS "createdBySlackUserId",
            created_at::text AS "createdAt"
        `
      : await this.sql`
          UPDATE events
          SET
            title = ${changes.title},
            description = ${changes.description},
            event_date = ${changes.eventDate},
            start_time = ${changes.startTime},
            end_time = ${changes.endTime}
          WHERE id = ${id}
          RETURNING
            id,
            title,
            description,
            event_date::text AS "eventDate",
            start_time::text AS "startTime",
            end_time::text AS "endTime",
            image_urls AS "imageUrls",
            slack_submission_id AS "slackSubmissionId",
            created_by_slack_user_id AS "createdBySlackUserId",
            created_at::text AS "createdAt"
        `;

    const event = rows[0];
    return event ? mapEventContent(event) : null;
  }

  async deleteEvent(id: string): Promise<ManageableEvent | null> {
    const rows = await this.sql`
      DELETE FROM events
      WHERE id = ${id}
      RETURNING
        id,
        title,
        description,
        event_date::text AS "eventDate",
        start_time::text AS "startTime",
        end_time::text AS "endTime",
        image_urls AS "imageUrls",
        created_by_slack_user_id AS "createdBySlackUserId"
    `;

    const event = rows[0];
    return event ? mapManageableEvent(event) : null;
  }

  async deleteEventsBefore(eventDate: string): Promise<ManageableEvent[]> {
    const rows = await this.sql`
      DELETE FROM events
      WHERE event_date < ${eventDate}
      RETURNING
        id,
        title,
        description,
        event_date::text AS "eventDate",
        start_time::text AS "startTime",
        end_time::text AS "endTime",
        image_urls AS "imageUrls",
        created_by_slack_user_id AS "createdBySlackUserId"
    `;

    return rows.map(mapManageableEvent);
  }
}
