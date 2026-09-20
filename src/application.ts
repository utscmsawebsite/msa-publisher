import { CalendarService } from "./calendar/calendar.service.js";
import { GoogleCalendarAdapter } from "./calendar/google-calendar.adapter.js";
import { NeonCalendarRepository } from "./calendar/neon-calendar.repository.js";
import { NeonContentRepository } from "./repositories/neon-content.repository.js";
import { NeonJummahRepository } from "./repositories/neon-jummah.repository.js";
import { ContentService } from "./services/content.service.js";
import { JummahService } from "./services/jummah.service.js";
import { VercelBlobImageStorage } from "./storage/vercel-blob-image.storage.js";

export function requireEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} must be defined in the environment variables.`);
  }

  return value;
}

export function createContentRepository(): NeonContentRepository {
  return new NeonContentRepository(requireEnvironmentVariable("DATABASE_URL"));
}

export function createContentService(): ContentService {
  const repository = createContentRepository();
  const imageStorage = new VercelBlobImageStorage(
    process.env.BLOB_READ_WRITE_TOKEN,
  );

  return new ContentService(repository, imageStorage);
}

export function createJummahService(): JummahService {
  const repository = new NeonJummahRepository(
    requireEnvironmentVariable("DATABASE_URL"),
  );

  return new JummahService(repository);
}

export function createCalendarService(): CalendarService {
  const serviceAccountEmail = requireEnvironmentVariable(
    "GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL",
  );
  const privateKey = requireEnvironmentVariable(
    "GOOGLE_CALENDAR_SERVICE_ACCOUNT_PRIVATE_KEY",
  ).replace(/\\n/g, "\n");
  const calendarId = requireEnvironmentVariable("GOOGLE_CALENDAR_ID");

  const adapter = new GoogleCalendarAdapter(
    serviceAccountEmail,
    privateKey,
    calendarId,
  );
  const repository = new NeonCalendarRepository(
    requireEnvironmentVariable("DATABASE_URL"),
  );

  return new CalendarService(adapter, repository);
}
