export interface CalendarEventDetails {
  summary: string;
  description?: string;
  location?: string;
  startDateTime: string;
  endDateTime: string;
}

export interface CalendarAdapter {
  createEvent(details: CalendarEventDetails): Promise<string>;
  updateEvent(eventId: string, details: CalendarEventDetails): Promise<void>;
  deleteEvent(eventId: string): Promise<void>;

  createWeeklyRecurringEvent(details: CalendarEventDetails): Promise<string>;
  updateRecurringEvent(
    eventId: string,
    details: CalendarEventDetails,
  ): Promise<void>;

  overrideNextOccurrence(
    recurringEventId: string,
    changes: { summary: string; description: string },
  ): Promise<void>;
  cancelNextOccurrence(recurringEventId: string): Promise<void>;
}
