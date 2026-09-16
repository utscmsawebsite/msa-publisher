export interface EventDraft {
  type: "event";
  title: string;
  description: string;
  eventDate: string;
  startTime: string;
  endTime: string;
  slackSubmissionId: string;
  createdBySlackUserId: string;
}

export interface EventContent extends EventDraft {
  id: string;
  createdAt: string;
  imageUrls: string[];
}

export interface EventUpdate {
  title: string;
  description: string;
  eventDate: string;
  startTime: string;
  endTime: string;
}

export interface ManageableEvent {
  id: string;
  title: string;
  description: string;
  eventDate: string;
  startTime: string | null;
  endTime: string | null;
  imageUrls: string[];
  createdBySlackUserId: string;
}

export interface PublicEvent {
  id: string;
  title: string;
  description: string;
  eventDate: string;
  startTime: string | null;
  endTime: string | null;
  imageUrls: string[];
}

export type Content = EventContent;
