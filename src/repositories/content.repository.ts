import type {
  Content,
  EventContent,
  EventUpdate,
  ManageableEvent,
  PublicEvent,
} from "../domain/content.js";

export interface ContentRepository {
  save(content: Content): Promise<Content>;
}

export interface EventQueryRepository {
  listVisibleEvents(): Promise<PublicEvent[]>;
}

export interface EventManagementRepository {
  listManageableEvents(): Promise<ManageableEvent[]>;
  findManageableEventById(id: string): Promise<ManageableEvent | null>;
  updateEvent(
    id: string,
    changes: EventUpdate,
    imageUrls?: string[],
  ): Promise<EventContent | null>;
  deleteEvent(id: string): Promise<ManageableEvent | null>;
  deleteEventsBefore(eventDate: string): Promise<ManageableEvent[]>;
}
