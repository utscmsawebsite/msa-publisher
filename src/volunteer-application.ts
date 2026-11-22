import { readFileSync } from "node:fs";
import { NeonVolunteerRepository } from "./repositories/neon-volunteer.repository.js";
import { VolunteerAdminService } from "./services/volunteer-admin.service.js";
import { VolunteerReportService } from "./services/volunteer-report.service.js";
import { VolunteerService } from "./services/volunteer.service.js";
import { defaultLetterheadLogo } from "./volunteer-reports/msa-logo.js";
import type { LetterheadConfig } from "./volunteer-reports/pdf.js";

// The volunteer system is wired up here, not in application.ts, on purpose.
// application.ts is loaded by the event and Jummah functions that serve the
// live bot and website. Keeping this separate means those functions never load
// the PDF libraries or any volunteer code, so they cannot be slowed down or
// broken by it. Only api/slack-volunteers.ts and the dev entry point import
// this file.

export function requireEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} must be defined in the environment variables.`);
  }

  return value;
}

function parseUserIds(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((userId) => userId.trim())
      .filter(Boolean),
  );
}

function loadLetterheadConfig(): LetterheadConfig {
  const logoPath = process.env.VOLUNTEER_LETTERHEAD_LOGO_PATH?.trim();
  let logo: Uint8Array | null = defaultLetterheadLogo;

  if (logoPath) {
    try {
      logo = readFileSync(logoPath);
    } catch (error) {
      console.warn(
        `Could not read VOLUNTEER_LETTERHEAD_LOGO_PATH (${logoPath}); letters will use the built-in MSA logo.`,
        error,
      );
    }
  }

  return {
    organizationName: process.env.VOLUNTEER_ORG_NAME?.trim() || "UTSC MSA",
    contactLine: process.env.VOLUNTEER_LETTERHEAD_CONTACT?.trim() || null,
    logo,
  };
}

export interface VolunteerServices {
  volunteer: VolunteerService;
  reports: VolunteerReportService;
  admin: VolunteerAdminService;
}

export function createVolunteerServices(): VolunteerServices {
  const repository = new NeonVolunteerRepository(
    requireEnvironmentVariable("DATABASE_URL"),
  );
  const adminUserIds = parseUserIds(process.env.SLACK_VOLUNTEER_ADMIN_USER_IDS);
  const volunteer = new VolunteerService(repository, adminUserIds);

  return {
    volunteer,
    reports: new VolunteerReportService(
      repository,
      loadLetterheadConfig(),
      adminUserIds,
    ),
    admin: new VolunteerAdminService(
      repository,
      adminUserIds,
      () => volunteer.invalidateFormData(),
    ),
  };
}
