import { createVolunteerServices } from "./volunteer-application.js";
import { createVolunteerSlackApp } from "./slack/volunteer-app.js";
import {
  assertSafeDevDatabase,
  databaseHost,
  loadVolunteerEnv,
} from "./volunteer-env.js";

async function main() {
  // The dev bot only runs against the database in .env.volunteers, never the
  // real one in .env (see volunteer-env.ts).
  assertSafeDevDatabase(loadVolunteerEnv());
  console.log(
    `Using database host: ${databaseHost(process.env.DATABASE_URL) ?? "(unknown)"} (from .env.volunteers). Confirm it is your TEST branch.`,
  );

  const app = createVolunteerSlackApp(createVolunteerServices());

  await app.start();
  console.log("⚡️ Volunteer hours Slack bot is running!");
}

main().catch((error: unknown) => {
  console.error(
    `Failed to start the volunteer hours bot:\n${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
