export interface JummahCalendarIds {
  first: string | null;
  second: string | null;
}

export interface CalendarRepository {
  getEventCalendarId(eventId: string): Promise<string | null>;
  setEventCalendarId(
    eventId: string,
    calendarEventId: string | null,
  ): Promise<void>;

  getJummahCalendarIds(): Promise<JummahCalendarIds>;
  setJummahCalendarIds(ids: JummahCalendarIds): Promise<void>;
}
