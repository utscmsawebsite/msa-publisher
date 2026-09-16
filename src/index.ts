import "dotenv/config";
import { createContentService, createJummahService } from "./application.js";
import { createSlackApp } from "./slack/bolt.js";

async function main() {
  const app = createSlackApp(createContentService(), createJummahService());

  await app.start();
  console.log("⚡️ Slack bot is running!");
}

main().catch((error: unknown) => {
  console.error("Failed to start MSA Publisher:", error);
  process.exitCode = 1;
});
