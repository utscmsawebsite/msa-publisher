import { neon } from "@neondatabase/serverless";
import {
  databaseHost,
  databaseSafetyProblem,
  loadVolunteerEnv,
} from "./volunteer-env.js";
import {
  evaluateSetup,
  formatCheckLine,
  hasFailure,
  REQUIRED_TABLES,
  type SetupInputs,
} from "./volunteer-setup-check.js";

/**
 * `npm run check:volunteers`: checks the dev setup before you start the bot.
 * It reads `.env.volunteers`, asks Slack whether the tokens work, and looks at
 * the test database. It only reads: it never posts to Slack and never changes
 * the database. Its output never contains a token, password or connection
 * string, so it is safe to paste into a chat.
 */
const loaded = loadVolunteerEnv();
const env = process.env;
const databaseUrl = env.DATABASE_URL?.trim() ?? "";

function scrub(message: string): string {
  const hidden = databaseUrl ? message.split(databaseUrl).join("[hidden]") : message;

  return hidden.slice(0, 240);
}

async function slackCall(
  method: string,
  token: string,
): Promise<{ ok: boolean; error?: string; team?: string; user?: string }> {
  try {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    return (await response.json()) as {
      ok: boolean;
      error?: string;
      team?: string;
      user?: string;
    };
  } catch (error) {
    return { ok: false, error: scrub(error instanceof Error ? error.message : String(error)) };
  }
}

async function checkSlack(): Promise<Pick<SetupInputs, "slack" | "socket">> {
  const botToken = env.SLACK_VOLUNTEER_BOT_TOKEN?.trim() ?? "";
  const appToken = env.SLACK_VOLUNTEER_APP_TOKEN?.trim() ?? "";
  let slack: SetupInputs["slack"] = null;
  let socket: SetupInputs["socket"] = null;

  if (botToken.startsWith("xoxb-")) {
    const result = await slackCall("auth.test", botToken);

    slack = result.ok
      ? { ok: true, team: result.team ?? "?", botName: result.user ?? "?" }
      : { ok: false, error: result.error ?? "unknown error" };
  }

  if (appToken.startsWith("xapp-")) {
    // Opens (and never uses) a connection URL, just to prove the token works.
    const result = await slackCall("apps.connections.open", appToken);

    socket = result.ok
      ? { ok: true }
      : { ok: false, error: result.error ?? "unknown error" };
  }

  return { slack, socket };
}

async function checkDatabase(): Promise<SetupInputs["database"]> {
  // Never connect to a database the safety rule would refuse to run against.
  if (!databaseUrl || databaseSafetyProblem(loaded, env)) {
    return null;
  }

  try {
    const sql = neon(databaseUrl);
    const present = await sql`
      SELECT table_name AS "name"
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = ANY(${[...REQUIRED_TABLES]}::text[])
    `;
    const found = new Set(present.map((row) => String(row.name)));
    const missingTables = REQUIRED_TABLES.filter((table) => !found.has(table));

    if (missingTables.length > 0) {
      return {
        ok: true,
        missingTables,
        categories: 0,
        years: 0,
        staff: 0,
        primaryApprovers: 0,
      };
    }

    const [counts] = await sql`
      SELECT
        (SELECT count(*) FROM volunteer_categories)::int AS "categories",
        (SELECT count(*) FROM volunteer_years)::int AS "years",
        (SELECT count(*) FROM volunteer_staff)::int AS "staff",
        (SELECT count(*) FROM volunteer_staff WHERE is_primary)::int AS "primary"
    `;

    return {
      ok: true,
      missingTables: [],
      categories: Number(counts?.categories ?? 0),
      years: Number(counts?.years ?? 0),
      staff: Number(counts?.staff ?? 0),
      primaryApprovers: Number(counts?.primary ?? 0),
    };
  } catch (error) {
    return {
      ok: false,
      error: scrub(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function main(): Promise<void> {
  const [slackResults, database] = await Promise.all([checkSlack(), checkDatabase()]);
  const lines = evaluateSetup({
    env,
    databaseFromVolunteerFile: loaded.databaseFromVolunteerFile,
    databaseHost: databaseHost(databaseUrl),
    ...slackResults,
    database,
  });

  console.log("\nVolunteer bot setup check\n");
  for (const line of lines) {
    console.log(formatCheckLine(line));
  }

  if (hasFailure(lines)) {
    console.log("\nFix the ❌ items above, then run this again.\n");
    process.exitCode = 1;
  } else {
    console.log("\nReady. Start the bot with: npm run dev:volunteers\n");
  }
}

main().catch((error: unknown) => {
  console.error("The check itself failed:", error instanceof Error ? scrub(error.message) : error);
  process.exitCode = 1;
});
