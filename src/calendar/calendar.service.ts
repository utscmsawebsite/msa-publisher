import type { EventContent } from "../domain/content.js";
import type { JummahContent } from "../domain/jummah.js";
import type { CalendarAdapter, CalendarEventDetails } from "./calendar.adapter.js";
import type { CalendarRepository } from "./calendar.repository.js";

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function nextFridayInToronto(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  const daysUntilFriday =
    (5 - (WEEKDAY_INDEX[values.weekday ?? "Sun"] ?? 0) + 7) % 7;

  const anchor = new Date(
    `${values.year}-${values.month}-${values.day}T00:00:00`,
  );
  anchor.setDate(anchor.getDate() + daysUntilFriday);

  return anchor.toISOString().slice(0, 10);
}

function eventDetails(event: EventContent): CalendarEventDetails {
  return {
    summary: event.title,
    description: event.description,
    location: event.location,
    startDateTime: `${event.eventDate}T${event.startTime}:00`,
    endDateTime: `${event.eventDate}T${event.endTime}:00`,
  };
}

function jummahSlotDetails(
  jummah: JummahContent,
  slot: "first" | "second",
): CalendarEventDetails {
  const startTime =
    slot === "first" ? jummah.firstStartTime : jummah.secondStartTime;
  const endTime = slot === "first" ? jummah.firstEndTime : jummah.secondEndTime;
  const location =
    slot === "first" ? jummah.firstLocation : jummah.secondLocation;

  if (!startTime || !endTime || !location) {
    throw new Error(`The ${slot} Jummah slot is missing required fields.`);
  }

  const date = nextFridayInToronto();

  return {
    summary: slot === "first" ? "Jummah Prayer" : "Second Jummah Prayer",
    location,
    startDateTime: `${date}T${startTime}:00`,
    endDateTime: `${date}T${endTime}:00`,
  };
}

export class CalendarService {
  constructor(
    private readonly adapter: CalendarAdapter,
    private readonly repository: CalendarRepository,
  ) {}

  async syncEventCreated(event: EventContent): Promise<void> {
    const calendarEventId = await this.adapter.createEvent(
      eventDetails(event),
    );
    await this.repository.setEventCalendarId(event.id, calendarEventId);
  }

  async syncEventUpdated(event: EventContent): Promise<void> {
    const details = eventDetails(event);
    const existingId = await this.repository.getEventCalendarId(event.id);

    if (existingId) {
      await this.adapter.updateEvent(existingId, details);
      return;
    }

    const calendarEventId = await this.adapter.createEvent(details);
    await this.repository.setEventCalendarId(event.id, calendarEventId);
  }

  async getEventCalendarId(eventId: string): Promise<string | null> {
    return this.repository.getEventCalendarId(eventId);
  }

  async getAllEventCalendarIds(): Promise<Map<string, string>> {
    return this.repository.getAllEventCalendarIds();
  }

  async syncEventDeleted(calendarEventId: string | null): Promise<void> {
    if (!calendarEventId) {
      return;
    }

    await this.adapter.deleteEvent(calendarEventId);
  }

  async syncJummahSchedule(jummah: JummahContent): Promise<void> {
    const ids = await this.repository.getJummahCalendarIds();
    const firstDetails = jummahSlotDetails(jummah, "first");

    let firstId = ids.first;
    if (firstId) {
      await this.adapter.updateRecurringEvent(firstId, firstDetails);
      // Restores this week's occurrence in case it was previously overridden
      // to "No Jummah on Campus" and service has since resumed.
      await this.adapter.overrideNextOccurrence(firstId, {
        summary: firstDetails.summary,
        description: "",
      });
    } else {
      firstId = await this.adapter.createWeeklyRecurringEvent(firstDetails);
    }

    const hasSecondSlot = Boolean(
      jummah.secondStartTime && jummah.secondEndTime && jummah.secondLocation,
    );
    let secondId = ids.second;

    if (hasSecondSlot) {
      const secondDetails = jummahSlotDetails(jummah, "second");
      if (secondId) {
        await this.adapter.updateRecurringEvent(secondId, secondDetails);
      } else {
        secondId = await this.adapter.createWeeklyRecurringEvent(secondDetails);
      }
    } else if (secondId) {
      await this.adapter.deleteEvent(secondId);
      secondId = null;
    }

    await this.repository.setJummahCalendarIds({ first: firstId, second: secondId });
  }

  async syncJummahUnavailable(jummah: JummahContent): Promise<void> {
    const ids = await this.repository.getJummahCalendarIds();

    if (!ids.first) {
      throw new Error(
        "Jummah must be synced to the calendar before it can be marked unavailable.",
      );
    }

    await this.adapter.overrideNextOccurrence(ids.first, {
      summary: "No Jummah on Campus",
      description: jummah.unavailableMessage ?? "",
    });

    if (ids.second) {
      await this.adapter.cancelNextOccurrence(ids.second);
    }
  }
}
