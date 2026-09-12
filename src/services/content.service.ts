import { randomUUID } from "node:crypto";
import type { EventContent, EventDraft } from "../domain/content.js";
import type { ContentRepository } from "../repositories/content.repository.js";
import type { ImageStorage, ImageUpload } from "../storage/image.storage.js";

const acceptedImageTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export class ContentService {
  constructor(
    private readonly repository: ContentRepository,
    private readonly imageStorage: ImageStorage,
  ) {}

  async createEvent(
    draft: EventDraft,
    imageUploads: ImageUpload[],
  ): Promise<EventContent> {
    const title = draft.title.trim();
    const description = draft.description.trim();

    if (!title || !description || !draft.eventDate) {
      throw new Error("All event fields are required.");
    }

    if (Boolean(draft.publishDate) !== Boolean(draft.publishTime)) {
      throw new Error(
        "Publication date and publication time must both be supplied or both be blank.",
      );
    }

    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!datePattern.test(draft.eventDate)) {
      throw new Error("Event date must use YYYY-MM-DD format.");
    }

    if (draft.publishDate && !datePattern.test(draft.publishDate)) {
      throw new Error("Publication date must use YYYY-MM-DD format.");
    }

    const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    if (draft.publishTime && !timePattern.test(draft.publishTime)) {
      throw new Error("Publication time must use 24-hour HH:MM format.");
    }

    if (imageUploads.length < 1 || imageUploads.length > 5) {
      throw new Error("An event must have between one and five images.");
    }

    if (imageUploads.some((image) => !acceptedImageTypes.has(image.mimeType))) {
      throw new Error("Event images must be JPEG, PNG, or WebP files.");
    }

    const id = randomUUID();
    const storedPathnames: string[] = [];

    try {
      const imageUrls: string[] = [];

      for (const [position, imageUpload] of imageUploads.entries()) {
        const stored = await this.imageStorage.saveEventImage(
          id,
          position,
          imageUpload,
        );
        storedPathnames.push(stored.pathname);

        imageUrls.push(stored.url);
      }

      const event: EventContent = {
        ...draft,
        title,
        description,
        id,
        createdAt: new Date().toISOString(),
        imageUrls,
      };

      await this.repository.save(event);
      return event;
    } catch (error) {
      await this.imageStorage.delete(storedPathnames).catch(() => undefined);
      throw error;
    }
  }
}
