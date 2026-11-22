import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateSetup,
  formatCheckLine,
  hasFailure,
  REQUIRED_TABLES,
  type SetupInputs,
} from "./volunteer-setup-check.js";

const BOT = ["xoxb", "1111111111", "2222222222", "fakefakefakefakefakefake"].join("-"); // built at run time so no token-shaped text sits in the source
const APP = ["xapp", "1", "A0FAKEFAKE", "3333333333", "fakefakefakefakefakefakefakefake"].join("-");
const DB_URL = "postgresql://dbuser:hunter2-password@ep-test-branch.neon.tech/neondb";

function inputs(overrides: Partial<SetupInputs> = {}): SetupInputs {
  return {
    env: {
      SLACK_VOLUNTEER_BOT_TOKEN: BOT,
      SLACK_VOLUNTEER_APP_TOKEN: APP,
      SLACK_VOLUNTEER_APPROVALS_CHANNEL_ID: "C0123456789",
      SLACK_VOLUNTEER_LOG_CHANNEL_ID: "C0123456789",
      SLACK_VOLUNTEER_ADMIN_USER_IDS: "U0123456789",
      DATABASE_URL: DB_URL,
    },
    databaseFromVolunteerFile: true,
    databaseHost: "ep-test-branch.neon.tech",
    slack: { ok: true, team: "UTSC MSA", botName: "msa_volunteer_hours" },
    socket: { ok: true },
    database: {
      ok: true,
      missingTables: [],
      categories: 3,
      years: 1,
      staff: 1,
      primaryApprovers: 1,
    },
    ...overrides,
  };
}

const failures = (lines: ReturnType<typeof evaluateSetup>) =>
  lines.filter((line) => line.level === "fail").map((line) => line.label);

describe("the setup check", () => {
  it("passes a complete, correct setup with no warnings", () => {
    const lines = evaluateSetup(inputs());

    assert.equal(hasFailure(lines), false);
    assert.deepEqual(lines.filter((line) => line.level !== "ok"), []);
  });

  it("says what is missing, in plain words, when nothing is set up", () => {
    const lines = evaluateSetup(
      inputs({ env: {}, databaseFromVolunteerFile: false, databaseHost: null, slack: null, socket: null, database: null }),
    );

    assert.equal(hasFailure(lines), true);
    assert.deepEqual(failures(lines), [
      "Bot token",
      "App-level token",
      "Approvals channel",
      "Admin users",
      "Database",
    ]);
  });

  it("notices swapped tokens", () => {
    const lines = evaluateSetup(
      inputs({ env: { ...inputs().env, SLACK_VOLUNTEER_BOT_TOKEN: APP, SLACK_VOLUNTEER_APP_TOKEN: BOT } }),
    );

    assert.deepEqual(failures(lines), ["Bot token", "App-level token"]);
    assert.match(lines.map((line) => line.detail ?? "").join(" "), /pasted the app-level token/);
  });

  it("notices a channel name or a user name pasted instead of an ID", () => {
    const lines = evaluateSetup(
      inputs({
        env: {
          ...inputs().env,
          SLACK_VOLUNTEER_APPROVALS_CHANNEL_ID: "#msa-publisher-logs",
          SLACK_VOLUNTEER_ADMIN_USER_IDS: "mustafa",
        },
      }),
    );

    assert.deepEqual(failures(lines), ["Approvals channel", "Admin users"]);
  });

  it("only warns when the optional log channel is missing", () => {
    const env = { ...inputs().env };
    delete env.SLACK_VOLUNTEER_LOG_CHANNEL_ID;
    const lines = evaluateSetup(inputs({ env }));

    assert.equal(hasFailure(lines), false);
    assert.ok(lines.some((line) => line.level === "warn" && line.label.includes("Log channel")));
  });

  it("fails if the database wouldn't be a separate test database", () => {
    const lines = evaluateSetup(inputs({ databaseFromVolunteerFile: false, database: null }));

    assert.deepEqual(failures(lines), ["Database is not a separate test database"]);
  });

  it("shows the database host so it can be compared with the Neon console", () => {
    const text = evaluateSetup(inputs()).map(formatCheckLine).join("\n");

    assert.ok(text.includes("ep-test-branch.neon.tech"));
  });

  it("reports rejected Slack tokens with the fix", () => {
    const lines = evaluateSetup(
      inputs({
        slack: { ok: false, error: "invalid_auth" },
        socket: { ok: false, error: "not_allowed_token_type" },
      }),
    );

    assert.deepEqual(failures(lines), ["Slack rejected the bot token", "Slack rejected the app-level token"]);
    const text = lines.map(formatCheckLine).join("\n");
    assert.ok(text.includes("invalid_auth"));
    assert.ok(text.includes("connections:write"));
  });

  it("tells you to apply the migration when tables are missing, naming them", () => {
    const lines = evaluateSetup(
      inputs({
        database: {
          ok: true,
          missingTables: ["volunteer_years", "volunteer_staff"],
          categories: 0,
          years: 0,
          staff: 0,
          primaryApprovers: 0,
        },
      }),
    );

    assert.deepEqual(failures(lines), ["The volunteer tables aren't in this database yet"]);
    const detail = lines.find((line) => line.level === "fail")?.detail ?? "";
    assert.ok(detail.includes("volunteer_years, volunteer_staff"));
    assert.ok(detail.includes("migrations/004"));
  });

  it("expects a fresh database to have no year or staff yet, and says how to add them", () => {
    const lines = evaluateSetup(
      inputs({
        database: { ok: true, missingTables: [], categories: 3, years: 0, staff: 0, primaryApprovers: 0 },
      }),
    );

    assert.equal(hasFailure(lines), false);
    const warnings = lines.filter((line) => line.level === "warn").map((line) => line.label);
    assert.deepEqual(warnings, ["No volunteer year yet", "No staff yet"]);
  });

  it("flags a database that can't be reached", () => {
    const lines = evaluateSetup(inputs({ database: { ok: false, error: "password authentication failed" } }));

    assert.deepEqual(failures(lines), ["Can't reach the database"]);
  });

  it("lists every table the migration creates", () => {
    assert.equal(REQUIRED_TABLES.length, 10);
    assert.ok(REQUIRED_TABLES.includes("volunteer_submission_changes"));
  });

  it("never prints a token, a password or the connection string", () => {
    const everything = [
      ...evaluateSetup(inputs()),
      ...evaluateSetup(inputs({ env: { ...inputs().env, SLACK_VOLUNTEER_BOT_TOKEN: APP } })),
      ...evaluateSetup(inputs({ slack: { ok: false, error: "invalid_auth" } })),
      ...evaluateSetup(inputs({ databaseFromVolunteerFile: false })),
    ]
      .map(formatCheckLine)
      .join("\n");

    for (const secret of [
      BOT,
      APP,
      DB_URL,
      "hunter2-password",
      "dbuser",
      "1111111111-2222222222",
      "abcdefghijklmnopqrstuvwx",
      "A0123456789-9999999999",
      "0123456789abcdef0123456789abcdef",
    ]) {
      assert.ok(!everything.includes(secret), `output leaked ${secret.slice(0, 8)}…`);
    }
  });
});
