import type {
  Content,
  EventUpdate,
  ManageableEvent,
} from "../domain/content.js";
import type {
  ContentRepository,
  EventManagementRepository,
} from "./content.repository.js";

export class InMemoryContentRepository
  implements ContentRepository, EventManagementRepository
{
  private readonly contents = new Map<string, Content>();

  async save(content: Content): Promise<Content> {
    const existing = [...this.contents.values()].find(
      (savedContent) =>
        savedContent.slackSubmissionId === content.slackSubmissionId,
    );

    if (existing) {
      return existing;
    }

    this.contents.set(content.id, content);
    return content;
  }

  async listManageableEvents(): Promise<ManageableEvent[]> {
    return [...this.contents.values()]
      .sort((left, right) =>
        `${left.eventDate} ${left.startTime}`.localeCompare(
          `${right.eventDate} ${right.startTime}`,
        ),
      )
      .slice(0, 100);
  }

  async findManageableEventById(id: string): Promise<ManageableEvent | null> {
    return this.contents.get(id) ?? null;
  }

  async updateEvent(
    id: string,
    changes: EventUpdate,
    imageUrls?: string[],
  ): Promise<Content | null> {
    const existing = this.contents.get(id);

    if (!existing) {
      return null;
    }

    const updated = {
      ...existing,
      ...changes,
      ...(imageUrls ? { imageUrls } : {}),
    };
    this.contents.set(id, updated);
    return updated;
  }

  async deleteEvent(id: string): Promise<ManageableEvent | null> {
    const existing = this.contents.get(id);

    if (!existing) {
      return null;
    }

    this.contents.delete(id);
    return existing;
  }

  async deleteEventsBefore(eventDate: string): Promise<ManageableEvent[]> {
    const staleEvents = [...this.contents.values()].filter(
      (content) => content.eventDate < eventDate,
    );

    for (const event of staleEvents) {
      this.contents.delete(event.id);
    }

    return staleEvents;
  }
}
