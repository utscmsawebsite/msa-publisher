import { NeonContentRepository } from "./repositories/neon-content.repository.js";
import { ContentService } from "./services/content.service.js";
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
