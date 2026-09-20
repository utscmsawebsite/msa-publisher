import { randomUUID } from "node:crypto";
import type {
  EventContent,
  EventDraft,
  EventUpdate,
  ManageableEvent,
} from "../domain/content.js";
import type {
  ContentRepository,
  EventManagementRepository,
} from "../repositories/content.repository.js";
import type { ImageStorage, ImageUpload } from "../storage/image.storage.js";

const acceptedImageTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type EventCreationFailureStage = "blob_upload" | "database_insert";

export class EventCreationError extends Error {
  constructor(
    readonly stage: EventCreationFailureStage,
    cause: unknown,
  ) {
    super(`Event creation failed during ${stage}.`, { cause });
    this.name = "EventCreationError";
  }
}

export interface CreateEventResult {
  event: EventContent;
  created: boolean;
}

export interface DeleteEventResult {
  event: ManageableEvent;
  blobCleanupSucceeded: boolean;
}

export interface StaleEventCleanupResult {
  deletedEvents: ManageableEvent[];
  blobCleanupSucceeded: boolean;
}

function dateInToronto(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  return `${values.year}-${values.month}-${values.day}`;
}

export type EventUpdateFailureStage = "blob_upload" | "database_update";

export class EventUpdateError extends Error {
  constructor(
    readonly stage: EventUpdateFailureStage,
    cause: unknown,
  ) {
    super(`Event update failed during ${stage}.`, { cause });
    this.name = "EventUpdateError";
  }
}

export interface UpdateEventResult {
  event: EventContent;
  imagesReplaced: boolean;
  oldImageCleanupSucceeded: boolean;
}

function validateEventDetails(event: EventUpdate): EventUpdate {
  const title = event.title.trim();
  const description = event.description.trim();
  const location = event.location.trim();

  if (
    !title ||
    !description ||
    !location ||
    !event.eventDate ||
    !event.startTime ||
    !event.endTime
  ) {
    throw new Error("All event fields are required.");
  }

  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(event.eventDate)) {
    throw new Error("Event date must use YYYY-MM-DD format.");
  }

  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (!timePattern.test(event.startTime) || !timePattern.test(event.endTime)) {
    throw new Error("Event times must use 24-hour HH:MM format.");
  }

  if (event.endTime <= event.startTime) {
    throw new Error("Event end time must be after its start time.");
  }

  return {
    ...event,
    title,
    description,
    location,
  };
}

export class ContentService {
  constructor(
    private readonly repository: ContentRepository & EventManagementRepository,
    private readonly imageStorage: ImageStorage,
  ) {}

  async createEvent(
    draft: EventDraft,
    imageUploads: ImageUpload[],
  ): Promise<CreateEventResult> {
    const details = validateEventDetails(draft);
    const slackSubmissionId = draft.slackSubmissionId.trim();

    if (!slackSubmissionId) {
      throw new Error("All event fields are required.");
    }

    if (imageUploads.length < 1 || imageUploads.length > 5) {
      throw new Error("An event must have between one and five images.");
    }

    if (imageUploads.some((image) => !acceptedImageTypes.has(image.mimeType))) {
      throw new Error("Event images must be JPEG, PNG, or WebP files.");
    }

    const id = randomUUID();
    const storedPathnames: string[] = [];
    let failureStage: EventCreationFailureStage = "blob_upload";

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
        ...details,
        slackSubmissionId,
        id,
        createdAt: new Date().toISOString(),
        imageUrls,
      };

      failureStage = "database_insert";
      const savedEvent = await this.repository.save(event);
      const created = savedEvent.id === event.id;

      if (!created) {
        await this.imageStorage.delete(storedPathnames).catch(() => undefined);
      }

      return {
        event: savedEvent,
        created,
      };
    } catch (error) {
      await this.imageStorage.delete(storedPathnames).catch(() => undefined);
      throw new EventCreationError(failureStage, error);
    }
  }

  async listManageableEvents(): Promise<ManageableEvent[]> {
    return this.repository.listManageableEvents();
  }

  async getManageableEvent(id: string): Promise<ManageableEvent | null> {
    return this.repository.findManageableEventById(id);
  }

  async updateEvent(
    id: string,
    changes: EventUpdate,
    imageUploads: ImageUpload[] = [],
  ): Promise<UpdateEventResult | null> {
    const validatedChanges = validateEventDetails(changes);
    const existing = await this.repository.findManageableEventById(id);

    if (!existing) {
      return null;
    }

    if (imageUploads.length === 0) {
      const event = await this.repository.updateEvent(id, validatedChanges);
      return event
        ? {
            event,
            imagesReplaced: false,
            oldImageCleanupSucceeded: true,
          }
        : null;
    }

    if (imageUploads.length > 5) {
      throw new Error("An event must have no more than five images.");
    }

    if (imageUploads.some((image) => !acceptedImageTypes.has(image.mimeType))) {
      throw new Error("Event images must be JPEG, PNG, or WebP files.");
    }

    const replacementStorageKey = `${id}/replacements/${randomUUID()}`;
    const replacementPathnames: string[] = [];
    const replacementUrls: string[] = [];
    let failureStage: EventUpdateFailureStage = "blob_upload";

    try {
      for (const [position, imageUpload] of imageUploads.entries()) {
        const stored = await this.imageStorage.saveEventImage(
          replacementStorageKey,
          position,
          imageUpload,
        );
        replacementPathnames.push(stored.pathname);
        replacementUrls.push(stored.url);
      }

      failureStage = "database_update";
      const event = await this.repository.updateEvent(
        id,
        validatedChanges,
        replacementUrls,
      );

      if (!event) {
        await this.imageStorage
          .delete(replacementPathnames)
          .catch(() => undefined);
        return null;
      }

      let oldImageCleanupSucceeded = true;
      try {
        await this.imageStorage.delete(existing.imageUrls);
      } catch {
        oldImageCleanupSucceeded = false;
      }

      return {
        event,
        imagesReplaced: true,
        oldImageCleanupSucceeded,
      };
    } catch (error) {
      await this.imageStorage
        .delete(replacementPathnames)
        .catch(() => undefined);
      throw new EventUpdateError(failureStage, error);
    }
  }

  async deleteEvent(id: string): Promise<DeleteEventResult | null> {
    const event = await this.repository.deleteEvent(id);

    if (!event) {
      return null;
    }

    let blobCleanupSucceeded = true;
    try {
      await this.imageStorage.delete(event.imageUrls);
    } catch {
      blobCleanupSucceeded = false;
    }

    return {
      event,
      blobCleanupSucceeded,
    };
  }

  async cleanupStaleEvents(): Promise<StaleEventCleanupResult> {
    const deletedEvents = await this.repository.deleteEventsBefore(
      dateInToronto(),
    );
    const imageUrls = deletedEvents.flatMap((event) => event.imageUrls);
    let blobCleanupSucceeded = true;

    try {
      await this.imageStorage.delete(imageUrls);
    } catch {
      blobCleanupSucceeded = false;
    }

    return {
      deletedEvents,
      blobCleanupSucceeded,
    };
  }
}
