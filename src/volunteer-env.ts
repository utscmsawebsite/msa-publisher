import { readFileSync } from "node:fs";
import path from "node:path";
import { config, parse } from "dotenv";

/**
 * Environment loading for running the volunteer bot on a developer machine.
 *
 * The real database URL lives in `.env`. To make sure a test run can never be
 * pointed at it by accident, the dev bot reads a separate `.env.volunteers`
 * first, and refuses to start unless that file sets DATABASE_URL itself (for
 * example a Neon branch made for testing). Nothing here applies on Vercel,
 * which uses its own environment variables.
 */
export const VOLUNTEER_ENV_FILE = ".env.volunteers";

export interface LoadedVolunteerEnv {
  /** `.env.volunteers` exists. */
  volunteerFileFound: boolean;
  /** `.env.volunteers` sets DATABASE_URL itself (not inherited from `.env`). */
  databaseFromVolunteerFile: boolean;
}

export function loadVolunteerEnv(cwd: string = process.cwd()): LoadedVolunteerEnv {
  const volunteerFile = path.join(cwd, VOLUNTEER_ENV_FILE);
  let volunteerFileFound = false;
  let databaseFromVolunteerFile = false;

  try {
    const parsed = parse(readFileSync(volunteerFile));

    volunteerFileFound = true;
    databaseFromVolunteerFile = Boolean(parsed.DATABASE_URL?.trim());
  } catch {
    // No such file: handled by the safety check below.
  }

  // dotenv never overrides a variable that is already set, so loading the
  // volunteer file first gives it priority over `.env`.
  config({ path: volunteerFile, quiet: true });
  config({ path: path.join(cwd, ".env"), quiet: true });

  return { volunteerFileFound, databaseFromVolunteerFile };
}

/** The database's host name only; never the user, password or database name. */
export function databaseHost(url: string | undefined): string | null {
  if (!url) {
    return null;
  }

  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export function databaseSafetyProblem(
  loaded: LoadedVolunteerEnv,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.VOLUNTEER_ALLOW_ENV_DATABASE === "1" || loaded.databaseFromVolunteerFile) {
    return null;
  }

  return loaded.volunteerFileFound
    ? `${VOLUNTEER_ENV_FILE} exists but doesn't set DATABASE_URL, so the bot would fall back to the database in .env, which may be your real one.`
    : `${VOLUNTEER_ENV_FILE} doesn't exist, so the bot would use the DATABASE_URL from .env, which may be your real database.`;
}

export function assertSafeDevDatabase(
  loaded: LoadedVolunteerEnv,
  env: Record<string, string | undefined> = process.env,
): void {
  const problem = databaseSafetyProblem(loaded, env);

  if (problem) {
    throw new Error(
      `${problem}\nCreate ${VOLUNTEER_ENV_FILE} with a DATABASE_URL for a Neon test branch (see docs/volunteer-testing.md). To deliberately use another database, set VOLUNTEER_ALLOW_ENV_DATABASE=1.`,
    );
  }
}
