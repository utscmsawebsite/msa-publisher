import {
  hasSlackAccount,
  type VolunteerCategory,
  type VolunteerEvent,
  type VolunteerProfile,
  type VolunteerStaffMember,
  type VolunteerYear,
  type YearStats,
} from "../domain/volunteer.js";
import type { VolunteerRepository } from "../repositories/volunteer.repository.js";
import { isValidIsoDate } from "./volunteer.service.js";

export type AdminResult = { ok: true; message: string } | { ok: false; message: string };

export interface StaffInput {
  slackUserId: string;
  displayName: string | null;
  title: string | null;
  canApprove: boolean;
  canManage: boolean;
  isPrimary: boolean;
}

export interface AdminData {
  categories: VolunteerCategory[];
  events: VolunteerEvent[];
  years: VolunteerYear[];
  staff: VolunteerStaffMember[];
  /** What is logged against each year, for the year screens. */
  yearStats: YearStats[];
}

const slackUserIdPattern = /^[UW][A-Z0-9]{6,}$/;

function fail(message: string): AdminResult {
  return { ok: false, message };
}

function succeed(message: string): AdminResult {
  return { ok: true, message };
}

function clean(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export class VolunteerAdminService {
  constructor(
    private readonly repository: VolunteerRepository,
    private readonly adminUserIds: ReadonlySet<string>,
    private readonly onCatalogChanged: () => void,
  ) {}

  isStaffAdmin(slackUserId: string): boolean {
    return this.adminUserIds.has(slackUserId);
  }

  async canManage(slackUserId: string): Promise<boolean> {
    if (this.adminUserIds.has(slackUserId)) {
      return true;
    }

    const staff = await this.repository.getStaffMember(slackUserId);

    return Boolean(staff?.canManage);
  }

  async loadData(): Promise<AdminData> {
    const [categories, events, years, staff, yearStats] = await Promise.all([
      this.repository.listCategories(),
      this.repository.listEvents(),
      this.repository.listYears(),
      this.repository.listStaff(),
      this.repository.listYearStats(),
    ]);

    return { categories, events, years, staff, yearStats };
  }

  async setStaffMember(
    actorSlackUserId: string,
    input: StaffInput,
  ): Promise<AdminResult> {
    if (!this.isStaffAdmin(actorSlackUserId)) {
      return fail("Only volunteer admins can change who is staff.");
    }

    if (!slackUserIdPattern.test(input.slackUserId)) {
      return fail("Pick a valid Slack user.");
    }

    if (!input.canApprove && !input.canManage) {
      return fail("Give them at least one permission (approve or manage).");
    }

    if (input.isPrimary && !input.canApprove) {
      return fail("The primary approver must be able to approve.");
    }

    const title = input.title === null ? null : clean(input.title);

    if (title !== null && title.length > 80) {
      return fail("Keep the title to 80 characters or fewer.");
    }

    await this.repository.upsertStaffMember(
      {
        slackUserId: input.slackUserId,
        displayName: input.displayName,
        title: title === "" ? null : title,
        canApprove: input.canApprove,
        canManage: input.canManage,
        isPrimary: input.isPrimary,
      },
      actorSlackUserId,
    );

    return succeed(
      `Saved <@${input.slackUserId}>${title ? ` (${title})` : ""}: ${
        [
          input.canApprove ? "can approve" : null,
          input.canManage ? "can manage" : null,
          input.isPrimary ? "primary approver" : null,
        ]
          .filter(Boolean)
          .join(", ") || "no permissions"
      }.`,
    );
  }

  async removeStaffMember(
    actorSlackUserId: string,
    slackUserId: string,
  ): Promise<AdminResult> {
    if (!this.isStaffAdmin(actorSlackUserId)) {
      return fail("Only volunteer admins can change who is staff.");
    }

    return (await this.repository.removeStaffMember(slackUserId))
      ? succeed(`Removed <@${slackUserId}> from volunteer staff.`)
      : fail("That person isn't volunteer staff.");
  }

  /** Volunteers an exec added who aren't linked to a Slack account yet. */
  async searchUnlinkedVolunteers(
    actorSlackUserId: string,
    query: string,
  ): Promise<VolunteerProfile[]> {
    const text = query.trim().slice(0, 60);

    if (!text || !(await this.canManage(actorSlackUserId))) {
      return [];
    }

    const matches = await this.repository.searchProfiles(text, 50);

    return matches
      .filter((profile) => !hasSlackAccount(profile.slackUserId))
      .slice(0, 20);
  }

  /**
   * The manual fallback for when the automatic match refuses (for example the
   * email or UTORid an exec typed differs from what the volunteer enters). It
   * moves a volunteer who has no Slack account, with all of their hours, onto
   * a Slack user. It never merges two existing records.
   */
  async linkVolunteerToSlack(
    actorSlackUserId: string,
    volunteerKey: string,
    slackUserId: string,
  ): Promise<AdminResult & { volunteerName?: string }> {
    if (!(await this.canManage(actorSlackUserId))) {
      return fail("You don't have permission to manage volunteer settings.");
    }

    if (!slackUserIdPattern.test(slackUserId)) {
      return fail("Pick a valid Slack user.");
    }

    const volunteer = await this.repository.getProfile(volunteerKey);

    if (!volunteer) {
      return fail("That volunteer no longer exists.");
    }

    if (hasSlackAccount(volunteer.slackUserId)) {
      return fail("That volunteer is already linked to a Slack account.");
    }

    if (await this.repository.getProfile(slackUserId)) {
      return fail(
        "That Slack user already has their own volunteer record, so the two can't be merged here.",
      );
    }

    let linked: boolean;

    try {
      linked = await this.repository.relinkProfile(volunteerKey, slackUserId);
    } catch {
      return fail("That Slack user already has a volunteer record.");
    }

    if (!linked) {
      return fail("That volunteer was just linked or changed. Try again.");
    }

    return {
      ...succeed(
        `Linked *${volunteer.fullName}* to <@${slackUserId}>. Their existing hours now show under that account.`,
      ),
      volunteerName: volunteer.fullName,
    };
  }

  async addCategory(
    actorSlackUserId: string,
    rawName: string,
    requiresEvent: boolean,
  ): Promise<AdminResult> {
    if (!(await this.canManage(actorSlackUserId))) {
      return fail("You don't have permission to manage volunteer settings.");
    }

    const name = clean(rawName);

    if (!name || name.length > 60) {
      return fail("Enter a category name (up to 60 characters).");
    }

    const categories = await this.repository.listCategories();

    if (
      categories.some(
        (category) => category.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      return fail("A category with that name already exists.");
    }

    await this.repository.createCategory(name, requiresEvent);
    this.onCatalogChanged();

    return succeed(`Added category *${name}*.`);
  }

  async updateCategory(
    actorSlackUserId: string,
    categoryId: string,
    changes: { name: string | null; isActive: boolean | null },
  ): Promise<AdminResult> {
    if (!(await this.canManage(actorSlackUserId))) {
      return fail("You don't have permission to manage volunteer settings.");
    }

    const name = changes.name === null ? null : clean(changes.name);

    if (name !== null && (name === "" || name.length > 60)) {
      return fail("Enter a category name (up to 60 characters).");
    }

    if (name === null && changes.isActive === null) {
      return fail("Enter a new name or choose a status.");
    }

    if (name !== null) {
      const categories = await this.repository.listCategories();

      if (
        categories.some(
          (category) =>
            category.id !== categoryId &&
            category.name.toLowerCase() === name.toLowerCase(),
        )
      ) {
        return fail("A category with that name already exists.");
      }
    }

    const updated = await this.repository.updateCategory(categoryId, {
      ...(name !== null ? { name } : {}),
      ...(changes.isActive !== null ? { isActive: changes.isActive } : {}),
    });

    if (!updated) {
      return fail("That category no longer exists.");
    }

    this.onCatalogChanged();

    return succeed(
      `Updated category *${updated.name}* (${updated.isActive ? "active" : "inactive"}).`,
    );
  }

  async addEvent(
    actorSlackUserId: string,
    rawName: string,
    eventDate: string | null,
  ): Promise<AdminResult> {
    if (!(await this.canManage(actorSlackUserId))) {
      return fail("You don't have permission to manage volunteer settings.");
    }

    const name = clean(rawName);

    if (!name || name.length > 80) {
      return fail("Enter an event name (up to 80 characters).");
    }

    if (eventDate !== null && !isValidIsoDate(eventDate)) {
      return fail("Choose a valid event date.");
    }

    await this.repository.createEvent(name, eventDate, actorSlackUserId);
    this.onCatalogChanged();

    return succeed(`Added event *${name}* to the volunteer pick-list.`);
  }

  async setEventActive(
    actorSlackUserId: string,
    eventId: string,
    isActive: boolean,
  ): Promise<AdminResult> {
    if (!(await this.canManage(actorSlackUserId))) {
      return fail("You don't have permission to manage volunteer settings.");
    }

    if (!(await this.repository.setEventActive(eventId, isActive))) {
      return fail("That event no longer exists.");
    }

    this.onCatalogChanged();

    return succeed(
      `Event is now ${isActive ? "active" : "inactive"} in the pick-list.`,
    );
  }

  async addYear(
    actorSlackUserId: string,
    rawLabel: string,
    startDate: string,
    endDate: string,
  ): Promise<AdminResult> {
    if (!(await this.canManage(actorSlackUserId))) {
      return fail("You don't have permission to manage volunteer settings.");
    }

    const label = clean(rawLabel);

    if (!label || label.length > 60) {
      return fail("Enter a year label (up to 60 characters).");
    }

    if (!isValidIsoDate(startDate) || !isValidIsoDate(endDate)) {
      return fail("Choose a valid start and end date.");
    }

    if (endDate <= startDate) {
      return fail("The end date must be after the start date.");
    }

    const years = await this.repository.listYears();

    if (years.some((year) => year.label.toLowerCase() === label.toLowerCase())) {
      return fail("A volunteer year with that label already exists.");
    }

    const overlapping = years.find(
      (year) => startDate <= year.endDate && endDate >= year.startDate,
    );

    if (overlapping) {
      return fail(
        `Those dates overlap ${overlapping.label} (${overlapping.startDate} to ${overlapping.endDate}).`,
      );
    }

    await this.repository.createYear(label, startDate, endDate);
    this.onCatalogChanged();

    return succeed(`Added *${label}* (${startDate} to ${endDate}).`);
  }

  /**
   * Renames a year or moves its dates. The label can always change. The dates
   * can only change while every date already logged against the year stays
   * inside them, so no hours are ever stranded outside their year.
   */
  async updateYear(
    actorSlackUserId: string,
    yearId: string,
    rawLabel: string,
    startDate: string,
    endDate: string,
  ): Promise<AdminResult> {
    if (!(await this.canManage(actorSlackUserId))) {
      return fail("You don't have permission to manage volunteer settings.");
    }

    const label = clean(rawLabel);

    if (!label || label.length > 60) {
      return fail("Enter a year label (up to 60 characters).");
    }

    if (!isValidIsoDate(startDate) || !isValidIsoDate(endDate)) {
      return fail("Choose a valid start and end date.");
    }

    if (endDate <= startDate) {
      return fail("The end date must be after the start date.");
    }

    const years = await this.repository.listYears();
    const others = years.filter((year) => year.id !== yearId);

    if (others.some((year) => year.label.toLowerCase() === label.toLowerCase())) {
      return fail("A volunteer year with that label already exists.");
    }

    const overlapping = others.find(
      (year) => startDate <= year.endDate && endDate >= year.startDate,
    );

    if (overlapping) {
      return fail(
        `Those dates overlap ${overlapping.label} (${overlapping.startDate} to ${overlapping.endDate}).`,
      );
    }

    let result;

    try {
      result = await this.repository.updateYear(yearId, label, startDate, endDate);
    } catch {
      // The unique label index caught a duplicate created a moment ago.
      return fail("A volunteer year with that label already exists.");
    }

    if (result.status === "not_found") {
      return fail("That volunteer year no longer exists.");
    }

    if (result.status === "entries_outside") {
      return fail(
        `${result.count} logged ${result.count === 1 ? "date" : "dates"} would fall outside those dates. Choose dates that keep every logged date inside the year.`,
      );
    }

    this.onCatalogChanged();

    return succeed(`Updated *${label}* (${startDate} to ${endDate}).`);
  }

  /** Only a year with nothing logged against it and no report can be deleted. */
  async deleteYear(
    actorSlackUserId: string,
    yearId: string,
  ): Promise<AdminResult> {
    if (!(await this.canManage(actorSlackUserId))) {
      return fail("You don't have permission to manage volunteer settings.");
    }

    const year = (await this.repository.listYears()).find(
      (candidate) => candidate.id === yearId,
    );

    if (!year) {
      return fail("That volunteer year no longer exists.");
    }

    let result;

    try {
      result = await this.repository.deleteYear(yearId);
    } catch {
      result = "in_use" as const;
    }

    if (result === "in_use") {
      return fail(
        `*${year.label}* has hours or reports logged against it, so it can't be deleted.`,
      );
    }

    if (result === "not_found") {
      return fail("That volunteer year no longer exists.");
    }

    this.onCatalogChanged();

    return succeed(`Deleted *${year.label}*.`);
  }

  async updateEvent(
    actorSlackUserId: string,
    eventId: string,
    rawName: string,
    eventDate: string | null,
  ): Promise<AdminResult> {
    if (!(await this.canManage(actorSlackUserId))) {
      return fail("You don't have permission to manage volunteer settings.");
    }

    const name = clean(rawName);

    if (!name || name.length > 80) {
      return fail("Enter an event name (up to 80 characters).");
    }

    if (eventDate !== null && !isValidIsoDate(eventDate)) {
      return fail("Choose a valid event date.");
    }

    const updated = await this.repository.updateEvent(eventId, name, eventDate);

    if (!updated) {
      return fail("That event no longer exists.");
    }

    this.onCatalogChanged();

    return succeed(`Updated event *${updated.name}*.`);
  }
}
