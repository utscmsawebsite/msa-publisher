import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  assertSafeDevDatabase,
  databaseHost,
  databaseSafetyProblem,
  loadVolunteerEnv,
} from "./volunteer-env.js";

const NAMES = ["DATABASE_URL", "VOLUNTEER_TEST_ONLY_VAR", "VOLUNTEER_ALLOW_ENV_DATABASE"];

describe("loading the dev environment", () => {
  let dir = "";
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "volunteer-env-"));
    for (const name of NAMES) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const name of NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it("uses .env.volunteers first, and only falls back to .env for what it doesn't set", () => {
    writeFileSync(path.join(dir, ".env.volunteers"), "DATABASE_URL=postgres://u:p@test-branch.example/db\n");
    writeFileSync(
      path.join(dir, ".env"),
      "DATABASE_URL=postgres://u:p@real-prod.example/db\nVOLUNTEER_TEST_ONLY_VAR=from-dot-env\n",
    );

    const loaded = loadVolunteerEnv(dir);

    assert.equal(process.env.DATABASE_URL, "postgres://u:p@test-branch.example/db");
    assert.equal(process.env.VOLUNTEER_TEST_ONLY_VAR, "from-dot-env");
    assert.deepEqual(loaded, { volunteerFileFound: true, databaseFromVolunteerFile: true });
    assert.equal(databaseSafetyProblem(loaded), null);
  });

  it("refuses to run when there is no .env.volunteers, even though .env has a database", () => {
    writeFileSync(path.join(dir, ".env"), "DATABASE_URL=postgres://u:p@real-prod.example/db\n");

    const loaded = loadVolunteerEnv(dir);

    assert.equal(process.env.DATABASE_URL, "postgres://u:p@real-prod.example/db");
    assert.deepEqual(loaded, { volunteerFileFound: false, databaseFromVolunteerFile: false });
    assert.match(databaseSafetyProblem(loaded) ?? "", /doesn't exist/);
    assert.throws(() => assertSafeDevDatabase(loaded), /real database/);
  });

  it("refuses when .env.volunteers exists but doesn't set DATABASE_URL", () => {
    writeFileSync(path.join(dir, ".env.volunteers"), "SLACK_VOLUNTEER_ADMIN_USER_IDS=U0123456789\n");
    writeFileSync(path.join(dir, ".env"), "DATABASE_URL=postgres://u:p@real-prod.example/db\n");

    const loaded = loadVolunteerEnv(dir);

    assert.deepEqual(loaded, { volunteerFileFound: true, databaseFromVolunteerFile: false });
    assert.match(databaseSafetyProblem(loaded) ?? "", /doesn't set DATABASE_URL/);
    assert.throws(() => assertSafeDevDatabase(loaded));
  });

  it("treats a blank DATABASE_URL in .env.volunteers as not set", () => {
    writeFileSync(path.join(dir, ".env.volunteers"), "DATABASE_URL=\n");

    assert.equal(loadVolunteerEnv(dir).databaseFromVolunteerFile, false);
  });

  it("allows another database only when explicitly asked", () => {
    const loaded = { volunteerFileFound: false, databaseFromVolunteerFile: false };

    assert.equal(databaseSafetyProblem(loaded, { VOLUNTEER_ALLOW_ENV_DATABASE: "1" }), null);
    assert.notEqual(databaseSafetyProblem(loaded, { VOLUNTEER_ALLOW_ENV_DATABASE: "yes" }), null);
    assert.notEqual(databaseSafetyProblem(loaded, {}), null);
  });
});

describe("showing which database is in use", () => {
  it("shows only the host, never credentials or the database name", () => {
    const url = "postgresql://secret_user:s3cr3t-password@ep-cool-branch-123.us-east-2.aws.neon.tech/private_db?sslmode=require";
    const host = databaseHost(url);

    assert.equal(host, "ep-cool-branch-123.us-east-2.aws.neon.tech");
    assert.ok(!String(host).includes("secret"));
    assert.ok(!String(host).includes("private_db"));
  });

  it("copes with missing or malformed values without throwing", () => {
    assert.equal(databaseHost(undefined), null);
    assert.equal(databaseHost(""), null);
    assert.equal(databaseHost("not a url"), null);
  });
});
