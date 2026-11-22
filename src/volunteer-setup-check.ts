/**
 * The pure part of `npm run check:volunteers`: turns what was found (variables,
 * Slack, the database) into a list of pass / warning / failure lines. Kept free
 * of any network or file access so it can be tested. It never includes a token,
 * password or connection string in its output.
 */
export type CheckLevel = "ok" | "warn" | "fail";

export interface CheckLine {
  level: CheckLevel;
  label: string;
  detail?: string;
}

export interface SetupInputs {
  env: Record<string, string | undefined>;
  databaseFromVolunteerFile: boolean;
  databaseHost: string | null;
  slack: { ok: true; team: string; botName: string } | { ok: false; error: string } | null;
  socket: { ok: true } | { ok: false; error: string } | null;
  database:
    | {
        ok: true;
        missingTables: string[];
        categories: number;
        years: number;
        staff: number;
        primaryApprovers: number;
      }
    | { ok: false; error: string }
    | null;
}

export const REQUIRED_TABLES = [
  "volunteer_years",
  "volunteer_profiles",
  "volunteer_categories",
  "volunteer_events",
  "volunteer_staff",
  "volunteer_submissions",
  "volunteer_entries",
  "volunteer_report_exports",
  "volunteer_report_export_entries",
  "volunteer_submission_changes",
] as const;

const channelPattern = /^[CG][A-Z0-9]{8,}$/;
const userPattern = /^[UW][A-Z0-9]{6,}$/;

function present(env: SetupInputs["env"], name: string): string {
  return env[name]?.trim() ?? "";
}

export function evaluateSetup(input: SetupInputs): CheckLine[] {
  const lines: CheckLine[] = [];
  const add = (level: CheckLevel, label: string, detail?: string) =>
    lines.push({ level, label, ...(detail ? { detail } : {}) });
  const { env } = input;

  const botToken = present(env, "SLACK_VOLUNTEER_BOT_TOKEN");
  if (!botToken) {
    add("fail", "Bot token", "SLACK_VOLUNTEER_BOT_TOKEN is missing (Slack app -> Install App -> Bot User OAuth Token).");
  } else if (!botToken.startsWith("xoxb-")) {
    add("fail", "Bot token", "SLACK_VOLUNTEER_BOT_TOKEN should start with xoxb- (you may have pasted the app-level token).");
  } else {
    add("ok", "Bot token is set");
  }

  const appToken = present(env, "SLACK_VOLUNTEER_APP_TOKEN");
  if (!appToken) {
    add("fail", "App-level token", "SLACK_VOLUNTEER_APP_TOKEN is missing (Basic Information -> App-Level Tokens, scope connections:write).");
  } else if (!appToken.startsWith("xapp-")) {
    add("fail", "App-level token", "SLACK_VOLUNTEER_APP_TOKEN should start with xapp- (you may have pasted the bot token).");
  } else {
    add("ok", "App-level token is set");
  }

  const approvals = present(env, "SLACK_VOLUNTEER_APPROVALS_CHANNEL_ID");
  if (!approvals) {
    add("fail", "Approvals channel", "SLACK_VOLUNTEER_APPROVALS_CHANNEL_ID is missing (channel details -> bottom of the About tab).");
  } else if (!channelPattern.test(approvals)) {
    add("fail", "Approvals channel", "That doesn't look like a channel ID (it should look like C0123456789, not a channel name).");
  } else {
    add("ok", "Approvals channel ID looks right");
  }

  const logChannel = present(env, "SLACK_VOLUNTEER_LOG_CHANNEL_ID");
  if (logChannel && !channelPattern.test(logChannel)) {
    add("fail", "Log channel", "SLACK_VOLUNTEER_LOG_CHANNEL_ID doesn't look like a channel ID.");
  } else if (!logChannel) {
    add("warn", "Log channel not set", "Optional, but without it admin changes and warnings aren't posted anywhere. Using the same channel as approvals is fine for testing.");
  } else {
    add("ok", "Log channel ID looks right");
  }

  const admins = present(env, "SLACK_VOLUNTEER_ADMIN_USER_IDS")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (admins.length === 0) {
    add("fail", "Admin users", "SLACK_VOLUNTEER_ADMIN_USER_IDS is missing. Put your own Slack member ID there so you can run /volunteer-admin.");
  } else if (admins.some((id) => !userPattern.test(id))) {
    add("fail", "Admin users", "Each ID should look like U0123456789 (profile -> three dots -> Copy member ID).");
  } else {
    add("ok", `${admins.length} admin user ID${admins.length === 1 ? "" : "s"} set`);
  }

  if (!present(env, "DATABASE_URL")) {
    add("fail", "Database", "DATABASE_URL is missing from .env.volunteers.");
  } else if (!input.databaseFromVolunteerFile && env.VOLUNTEER_ALLOW_ENV_DATABASE !== "1") {
    add("fail", "Database is not a separate test database", "DATABASE_URL isn't set in .env.volunteers, so this would use the one in .env, which may be your real database. Put your Neon test branch's URL in .env.volunteers.");
  } else {
    add("ok", "Database comes from .env.volunteers", input.databaseHost ? `host: ${input.databaseHost}. Check this is your TEST branch's host in the Neon console, not your main one.` : undefined);
  }

  if (input.slack) {
    input.slack.ok
      ? add("ok", `Slack accepts the bot token: workspace "${input.slack.team}", bot "${input.slack.botName}"`)
      : add("fail", "Slack rejected the bot token", `${input.slack.error}. Re-copy the Bot User OAuth Token after installing the app.`);
  }

  if (input.socket) {
    input.socket.ok
      ? add("ok", "Slack accepts the app-level token (Socket Mode will connect)")
      : add("fail", "Slack rejected the app-level token", `${input.socket.error}. It needs the connections:write scope, and Socket Mode must be on.`);
  }

  if (input.database) {
    if (!input.database.ok) {
      add("fail", "Can't reach the database", input.database.error);
    } else if (input.database.missingTables.length > 0) {
      add("fail", "The volunteer tables aren't in this database yet", `Missing: ${input.database.missingTables.join(", ")}. Apply migrations/004_create_volunteer_tables.sql to the test branch.`);
    } else {
      add("ok", "All volunteer tables exist");
      input.database.categories > 0
        ? add("ok", `${input.database.categories} categories`)
        : add("fail", "No categories", "The migration seeds General, Jummah and Specific Event. Re-run it on this database.");
      input.database.years > 0
        ? add("ok", `${input.database.years} volunteer year${input.database.years === 1 ? "" : "s"}`)
        : add("warn", "No volunteer year yet", "Expected on a fresh database. Add one in /volunteer-admin → Years → + New year before logging hours.");
      input.database.staff > 0
        ? add("ok", `${input.database.staff} staff member${input.database.staff === 1 ? "" : "s"}${input.database.primaryApprovers === 0 ? " (none is the primary approver)" : ""}`)
        : add("warn", "No staff yet", "Expected on a fresh database. Add yourself in /volunteer-admin → Staff → + Add staff member (approve + manage + primary, with a title).");
    }
  }

  return lines;
}

export function hasFailure(lines: CheckLine[]): boolean {
  return lines.some((line) => line.level === "fail");
}

export function formatCheckLine(line: CheckLine): string {
  const icon = line.level === "ok" ? "✅" : line.level === "warn" ? "⚠️ " : "❌";

  return `${icon} ${line.label}${line.detail ? `\n     ${line.detail}` : ""}`;
}
