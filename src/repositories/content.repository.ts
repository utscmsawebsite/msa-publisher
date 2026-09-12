import type { Content, PublicEvent } from "../domain/content.js";

export interface ContentRepository {
  save(content: Content): Promise<Content>;
}

export interface EventQueryRepository {
  listVisibleEvents(): Promise<PublicEvent[]>;
}
