import { neon } from "@neondatabase/serverless";
import type { Content, PublicEvent } from "../domain/content.js";
import type {
  ContentRepository,
  EventQueryRepository,
} from "./content.repository.js";

export class NeonContentRepository
  implements ContentRepository, EventQueryRepository
{
  private readonly sql;

  constructor(databaseUrl: string) {
    this.sql = neon(databaseUrl);
  }

  async save(content: Content): Promise<Content> {
    await this.sql`
      INSERT INTO events (
        id,
        title,
        description,
        publish_date,
        publish_time,
        event_date,
        image_urls,
        created_by_slack_user_id,
        created_at
      ) VALUES (
        ${content.id},
        ${content.title},
        ${content.description},
        ${content.publishDate},
        ${content.publishTime},
        ${content.eventDate},
        ${content.imageUrls},
        ${content.createdBySlackUserId},
        ${content.createdAt}
      )
    `;

    return content;
  }

  async listVisibleEvents(): Promise<PublicEvent[]> {
    const rows = await this.sql`
      SELECT
        id,
        title,
        description,
        event_date::text AS "eventDate",
        image_urls AS "imageUrls"
      FROM events
      WHERE event_date >= (now() AT TIME ZONE 'America/Toronto')::date
        AND (
          publish_date IS NULL
          OR publish_date + publish_time <= now() AT TIME ZONE 'America/Toronto'
      )
      ORDER BY event_date ASC, created_at ASC
    `;

    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      description: String(row.description),
      eventDate: String(row.eventDate),
      imageUrls: Array.isArray(row.imageUrls)
        ? row.imageUrls.map((url) => String(url))
        : [],
    }));
  }
}
