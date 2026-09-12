export interface EventDraft {
  type: "event";
  title: string;
  description: string;
  publishDate: string | null;
  publishTime: string | null;
  eventDate: string;
  createdBySlackUserId: string;
}

export interface EventContent extends EventDraft {
  id: string;
  createdAt: string;
  imageUrls: string[];
}

export interface PublicEvent {
  id: string;
  title: string;
  description: string;
  eventDate: string;
  imageUrls: string[];
}

export type Content = EventContent;
