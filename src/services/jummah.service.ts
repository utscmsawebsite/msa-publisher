import type { JummahContent, JummahDraft } from "../domain/jummah.js";
import type { JummahRepository } from "../repositories/jummah.repository.js";

export class JummahService {
  constructor(private readonly repository: JummahRepository) {}

  async getCurrent(): Promise<JummahContent | null> {
    return this.repository.getCurrent();
  }

  async save(draft: JummahDraft): Promise<JummahContent> {
    const firstStartTime = draft.firstStartTime.trim();
    const firstEndTime = draft.firstEndTime.trim();
    const firstLocation = draft.firstLocation.trim();
    const secondStartTime = draft.secondStartTime?.trim() || null;
    const secondEndTime = draft.secondEndTime?.trim() || null;
    const suppliedSecondLocation = draft.secondLocation?.trim() || null;
    const updatedBySlackUserId = draft.updatedBySlackUserId.trim();

    if (
      !firstStartTime ||
      !firstEndTime ||
      !firstLocation ||
      !updatedBySlackUserId
    ) {
      throw new Error(
        "First Jummah start time, end time, and location are required.",
      );
    }

    const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    if (
      !timePattern.test(firstStartTime) ||
      !timePattern.test(firstEndTime)
    ) {
      throw new Error("First Jummah times must use 24-hour HH:MM format.");
    }

    if (firstEndTime <= firstStartTime) {
      throw new Error("First Jummah end time must be after its start time.");
    }

    if (Boolean(secondStartTime) !== Boolean(secondEndTime)) {
      throw new Error(
        "Second Jummah requires both a start time and an end time.",
      );
    }

    if (
      secondStartTime &&
      secondEndTime &&
      (!timePattern.test(secondStartTime) ||
        !timePattern.test(secondEndTime))
    ) {
      throw new Error("Second Jummah times must use 24-hour HH:MM format.");
    }

    if (
      secondStartTime &&
      secondEndTime &&
      secondEndTime <= secondStartTime
    ) {
      throw new Error("Second Jummah end time must be after its start time.");
    }

    if (suppliedSecondLocation && !secondStartTime) {
      throw new Error(
        "Second Jummah times are required when its location is provided.",
      );
    }

    return this.repository.upsert({
      firstStartTime,
      firstEndTime,
      firstLocation,
      secondStartTime,
      secondEndTime,
      secondLocation: secondStartTime
        ? suppliedSecondLocation ?? firstLocation
        : null,
      updatedBySlackUserId,
    });
  }
}
