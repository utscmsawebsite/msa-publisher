import { del, put } from "@vercel/blob";
import type {
  ImageStorage,
  ImageUpload,
  StoredImage,
} from "./image.storage.js";

function safeFilename(filename: string): string {
  const sanitized = filename
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);

  return sanitized || "image";
}

export class VercelBlobImageStorage implements ImageStorage {
  constructor(private readonly token?: string) {}

  async saveEventImage(
    eventId: string,
    position: number,
    image: ImageUpload,
  ): Promise<StoredImage> {
    const pathname = `events/${eventId}/${position + 1}-${safeFilename(image.originalName)}`;
    const commonOptions = {
      access: "public" as const,
      addRandomSuffix: false,
      contentType: image.mimeType,
      multipart: true,
    };

    const blob = this.token
      ? await put(pathname, image.body, { ...commonOptions, token: this.token })
      : await put(pathname, image.body, commonOptions);

    return {
      url: blob.url,
      pathname: blob.pathname,
    };
  }

  async delete(pathnames: string[]): Promise<void> {
    if (pathnames.length === 0) {
      return;
    }

    if (this.token) {
      await del(pathnames, { token: this.token });
      return;
    }

    await del(pathnames);
  }
}
