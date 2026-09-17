import { neon } from "@neondatabase/serverless";
import type {
  JummahContent,
  JummahDraft,
  JummahUnavailableDraft,
} from "../domain/jummah.js";
import type { JummahRepository } from "./jummah.repository.js";

type DatabaseRow = Record<string, unknown>;

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function time(value: unknown): string {
  return String(value).slice(0, 5);
}

function nullableTime(value: unknown): string | null {
  return value === null || value === undefined
    ? null
    : String(value).slice(0, 5);
}

function mapJummah(row: DatabaseRow): JummahContent {
  return {
    id: "current",
    firstStartTime: time(row.firstStartTime),
    firstEndTime: time(row.firstEndTime),
    firstLocation: String(row.firstLocation),
    secondStartTime: nullableTime(row.secondStartTime),
    secondEndTime: nullableTime(row.secondEndTime),
    secondLocation: nullableString(row.secondLocation),
    isOffered: Boolean(row.isOffered),
    unavailableMessage: nullableString(row.unavailableMessage),
    updatedBySlackUserId: String(row.updatedBySlackUserId),
    updatedAt: String(row.updatedAt),
  };
}

export class NeonJummahRepository implements JummahRepository {
  private readonly sql;

  constructor(databaseUrl: string) {
    this.sql = neon(databaseUrl);
  }

  async getCurrent(): Promise<JummahContent | null> {
    const rows = await this.sql`
      SELECT
        id,
        to_char(first_start_time, 'HH24:MI') AS "firstStartTime",
        to_char(first_end_time, 'HH24:MI') AS "firstEndTime",
        first_location AS "firstLocation",
        to_char(second_start_time, 'HH24:MI') AS "secondStartTime",
        to_char(second_end_time, 'HH24:MI') AS "secondEndTime",
        second_location AS "secondLocation",
        is_offered AS "isOffered",
        unavailable_message AS "unavailableMessage",
        updated_by_slack_user_id AS "updatedBySlackUserId",
        updated_at::text AS "updatedAt"
      FROM jummah
      WHERE id = 'current'
      LIMIT 1
    `;

    const jummah = rows[0];
    return jummah ? mapJummah(jummah) : null;
  }

  async upsert(draft: JummahDraft): Promise<JummahContent> {
    const rows = await this.sql`
      INSERT INTO jummah (
        id,
        first_start_time,
        first_end_time,
        first_location,
        second_start_time,
        second_end_time,
        second_location,
        is_offered,
        updated_by_slack_user_id
      ) VALUES (
        'current',
        ${draft.firstStartTime},
        ${draft.firstEndTime},
        ${draft.firstLocation},
        ${draft.secondStartTime},
        ${draft.secondEndTime},
        ${draft.secondLocation},
        true,
        ${draft.updatedBySlackUserId}
      )
      ON CONFLICT (id) DO UPDATE SET
        first_start_time = EXCLUDED.first_start_time,
        first_end_time = EXCLUDED.first_end_time,
        first_location = EXCLUDED.first_location,
        second_start_time = EXCLUDED.second_start_time,
        second_end_time = EXCLUDED.second_end_time,
        second_location = EXCLUDED.second_location,
        is_offered = true,
        updated_by_slack_user_id = EXCLUDED.updated_by_slack_user_id,
        updated_at = now()
      RETURNING
        id,
        to_char(first_start_time, 'HH24:MI') AS "firstStartTime",
        to_char(first_end_time, 'HH24:MI') AS "firstEndTime",
        first_location AS "firstLocation",
        to_char(second_start_time, 'HH24:MI') AS "secondStartTime",
        to_char(second_end_time, 'HH24:MI') AS "secondEndTime",
        second_location AS "secondLocation",
        is_offered AS "isOffered",
        unavailable_message AS "unavailableMessage",
        updated_by_slack_user_id AS "updatedBySlackUserId",
        updated_at::text AS "updatedAt"
    `;

    const jummah = rows[0];
    if (!jummah) {
      throw new Error("The Jummah update did not return a database record.");
    }

    return mapJummah(jummah);
  }

  async markUnavailable(
    draft: JummahUnavailableDraft,
  ): Promise<JummahContent> {
    const rows = await this.sql`
      UPDATE jummah
      SET
        is_offered = false,
        unavailable_message = ${draft.unavailableMessage},
        updated_by_slack_user_id = ${draft.updatedBySlackUserId},
        updated_at = now()
      WHERE id = 'current'
      RETURNING
        id,
        to_char(first_start_time, 'HH24:MI') AS "firstStartTime",
        to_char(first_end_time, 'HH24:MI') AS "firstEndTime",
        first_location AS "firstLocation",
        to_char(second_start_time, 'HH24:MI') AS "secondStartTime",
        to_char(second_end_time, 'HH24:MI') AS "secondEndTime",
        second_location AS "secondLocation",
        is_offered AS "isOffered",
        unavailable_message AS "unavailableMessage",
        updated_by_slack_user_id AS "updatedBySlackUserId",
        updated_at::text AS "updatedAt"
    `;

    const jummah = rows[0];
    if (!jummah) {
      throw new Error(
        "A Jummah schedule must be saved before it can be marked unavailable.",
      );
    }

    return mapJummah(jummah);
  }
}
