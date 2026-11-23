import { logError, logInfo, logWarning } from "../logging/application-logger.js";
import {
  type AdminResult,
  type VolunteerAdminService,
} from "../services/volunteer-admin.service.js";
import { todayInToronto } from "../services/volunteer.service.js";
import {
  ACK_BUDGET_MS,
  settleWithin,
  type SlackClient,
  type VolunteerSlackContext,
} from "./volunteer-context.js";
import {
  ADMIN_FORM_CALLBACK,
  adminActionIds,
  adminNavActionIds,
  adminBlockIds,
  buildCategoriesView,
  buildCategoryFormView,
  buildEventFormView,
  buildEventsView,
  buildLinkFormView,
  buildStaffFormView,
  buildStaffView,
  buildYearFormView,
  buildYearView,
  buildYearsView,
  type AdminViewContext,
  type FormKind,
  type FormMetadata,
} from "./volunteer-admin-views.js";
import { buildAdminHomeView, type HubBack } from "./volunteer-hub-views.js";
import {
  buildLoadingView,
  buildMessageView,
  parseJsonMetadata,
  volunteerOption,
  type ModalView,
  type StateValuesLike,
} from "./volunteer-views.js";

const NOT_ALLOWED =
  "Only volunteer admins can manage volunteer settings. Use /volunteer for your own hours.";
const NOT_STAFF_ADMIN =
  "⚠️ Only the volunteer admins named in the bot's settings can change who is staff.";

const formKinds: readonly FormKind[] = ["year", "staff", "category", "event", "link"];

/** What the screens need to draw themselves, loaded fresh each time. */
export async function loadAdminContext(
  admin: VolunteerAdminService,
  userId: string,
): Promise<AdminViewContext> {
  return {
    data: await admin.loadData(),
    today: todayInToronto(),
    canChangeStaff: admin.isStaffAdmin(userId),
  };
}

/**
 * Builds the screen a key names (see volunteer-admin-views.ts). Every call
 * checks permission first, so an old screen left open can't be used by
 * someone who has lost access.
 */
export async function renderAdminScreen(
  admin: VolunteerAdminService,
  userId: string,
  key: string,
  notice: string | null = null,
): Promise<ModalView> {
  if (!(await admin.canManage(userId))) {
    logWarning("volunteer_authorization_denied", {
      slackUserId: userId,
      action: "admin_screen",
      screen: key,
    });

    return buildMessageView("Volunteer admin", NOT_ALLOWED);
  }

  const context = await loadAdminContext(admin, userId);
  const { data } = context;
  const [head = "", second = "", third = "", ...rest] = key.split(":");
  const join = (...parts: string[]) => parts.filter(Boolean).join(":");

  switch (head) {
    case "home":
      return buildAdminHomeView(context, notice);
    case "years":
      return buildYearsView(context, notice);
    case "staff":
      return buildStaffView(context, notice);
    case "categories":
      return buildCategoriesView(context, notice);
    case "events":
      return buildEventsView(context, notice);
    case "link":
      return buildLinkFormView("home");
    case "year": {
      const year = data.years.find((candidate) => candidate.id === second);

      return year
        ? buildYearView(context, year, notice)
        : buildYearsView(context, "⚠️ That volunteer year no longer exists.");
    }
    case "add": {
      // add:year, add:staff, add:category, add:event[:year:<id>]
      if (second === "year") {
        return buildYearFormView(
          null,
          undefined,
          "years",
          data.years.some((candidate) => candidate.isDefault),
        );
      }

      if (second === "staff") {
        return context.canChangeStaff
          ? buildStaffFormView(null, "staff")
          : buildStaffView(context, NOT_STAFF_ADMIN);
      }

      if (second === "category") {
        return buildCategoryFormView(null, "categories");
      }

      if (second === "event") {
        const year =
          third === "year"
            ? data.years.find((candidate) => candidate.id === rest[0])
            : undefined;
        const suggested = year
          ? context.today >= year.startDate && context.today <= year.endDate
            ? context.today
            : year.startDate
          : null;

        return buildEventFormView(null, year ? `year:${year.id}` : "events", suggested);
      }

      break;
    }
    case "edit": {
      // edit:year:<id>, edit:staff:<id>, edit:category:<id>,
      // edit:event:<id>[:<screen to return to>]
      if (second === "year") {
        const year = data.years.find((candidate) => candidate.id === third);

        return year
          ? buildYearFormView(
              year,
              data.yearStats.find((stats) => stats.yearId === year.id),
              `year:${year.id}`,
            )
          : buildYearsView(context, "⚠️ That volunteer year no longer exists.");
      }

      if (second === "staff") {
        if (!context.canChangeStaff) {
          return buildStaffView(context, NOT_STAFF_ADMIN);
        }

        const member = data.staff.find((candidate) => candidate.slackUserId === third);

        return member
          ? buildStaffFormView(member, "staff")
          : buildStaffView(context, "⚠️ That person isn't volunteer staff any more.");
      }

      if (second === "category") {
        const category = data.categories.find((candidate) => candidate.id === third);

        return category
          ? buildCategoryFormView(
              category,
              "categories",
              data.events.filter((event) => event.isActive),
            )
          : buildCategoriesView(context, "⚠️ That category no longer exists.");
      }

      if (second === "event") {
        const event = data.events.find((candidate) => candidate.id === third);

        return event
          ? buildEventFormView(event, join(...rest) || "events")
          : buildEventsView(context, "⚠️ That event no longer exists.");
      }

      break;
    }
    default:
      break;
  }

  return buildAdminHomeView(context, "⚠️ That screen isn't available any more.");
}

async function lookupDisplayName(
  client: SlackClient,
  slackUserId: string,
): Promise<string | null> {
  try {
    const result = await client.users.info({ user: slackUserId });

    return result.user?.real_name ?? result.user?.name ?? null;
  } catch {
    return null;
  }
}

interface FormOutcome {
  ok: boolean;
  message: string;
  /** The block the message belongs under when the form can't be saved. */
  field: string;
  /** Extra work to do after Slack has been answered. */
  after?: () => Promise<void>;
}

type FormResult =
  | { errors: Record<string, string> }
  | { view: ModalView; after: () => Promise<void> };

export function registerVolunteerAdminHandlers(
  context: VolunteerSlackContext,
  admin: VolunteerAdminService,
  deps: {
    beginReport: (
      client: SlackClient,
      viewId: string,
      userId: string,
      home?: HubBack,
      yearId?: string,
    ) => Promise<void>;
  },
): void {
  const { app, background, opsLog } = context;

  app.options(adminActionIds.linkSearch, async ({ ack, body, options }) => {
    try {
      const matches = await admin.searchUnlinkedVolunteers(
        body.user.id,
        options.value,
      );

      await ack({ options: matches.map(volunteerOption) });
    } catch (error) {
      logError("volunteer_admin_search_failed", error, {
        slackUserId: body.user.id,
      });
      await ack({ options: [] });
    }
  });

  const show = async (
    client: SlackClient,
    viewId: string,
    userId: string,
    key: string,
    notice: string | null,
  ): Promise<void> => {
    try {
      await client.views.update({
        view_id: viewId,
        view: await renderAdminScreen(admin, userId, key, notice),
      });
    } catch (error) {
      logError("volunteer_admin_screen_failed", error, {
        slackUserId: userId,
        screen: key,
      });
      await client.views
        .update({
          view_id: viewId,
          view: buildMessageView(
            "Volunteer admin",
            "Sorry, that screen could not be opened. Please run /volunteer-admin again.",
          ),
        })
        .catch(() => undefined);
    }
  };

  const modalOf = (body: unknown): string | undefined =>
    (body as { view?: { id?: string } }).view?.id;

  const record = async (
    client: SlackClient,
    actor: string,
    action: string,
    message: string,
  ): Promise<void> => {
    logInfo("volunteer_admin_change", { slackUserId: actor, action });
    await opsLog(client, `🛠️ Volunteer admin change by <@${actor}>\n${message}`);
  };

  // The same handler serves every nav button, including the side-by-side ones
  // that carry a slot in their action_id (see adminNavSlots).
  for (const navActionId of adminNavActionIds) {
    app.action(navActionId, async ({ ack, action, body, client }) => {
      await ack();
      const key = "value" in action ? action.value : undefined;
      const viewId = modalOf(body);

      if (!key || !viewId) {
        return;
      }

      await background("admin_nav", () =>
        show(client, viewId, body.user.id, key, null),
      );
    });
  }

  app.action(adminActionIds.yearReport, async ({ ack, action, body, client }) => {
    await ack();
    const yearId = "value" in action ? action.value : undefined;
    const viewId = modalOf(body);

    if (!yearId || !viewId) {
      return;
    }

    await background("admin_year_report", async () => {
      try {
        await client.views.update({
          view_id: viewId,
          view: buildLoadingView("CCR report"),
        });
        await deps.beginReport(client, viewId, body.user.id, `admin:year:${yearId}`, yearId);
      } catch (error) {
        logError("volunteer_admin_year_report_failed", error, {
          slackUserId: body.user.id,
        });
        await client.views
          .update({
            view_id: viewId,
            view: buildMessageView(
              "CCR report",
              "Sorry, the report form could not be opened. Please try again.",
            ),
          })
          .catch(() => undefined);
      }
    });
  });

  app.action(adminActionIds.danger, async ({ ack, action, body, client }) => {
    await ack();
    const value = "value" in action ? action.value : undefined;
    const viewId = modalOf(body);
    const actor = body.user.id;

    if (!value || !viewId) {
      return;
    }

    await background("admin_danger", async () => {
      const [kind = "", id = ""] = value.split(":");

      try {
        if (kind === "year") {
          const result = await admin.deleteYear(actor, id);

          if (result.ok) {
            await record(client, actor, "year_delete", result.message);
          }

          await show(
            client,
            viewId,
            actor,
            result.ok ? "years" : `year:${id}`,
            result.ok ? result.message : `⚠️ ${result.message}`,
          );
        } else if (kind === "staff") {
          const result = await admin.removeStaffMember(actor, id);

          if (result.ok) {
            await record(client, actor, "staff_remove", result.message);
          }

          await show(
            client,
            viewId,
            actor,
            "staff",
            result.ok ? result.message : `⚠️ ${result.message}`,
          );
        }
      } catch (error) {
        logError("volunteer_admin_danger_failed", error, {
          slackUserId: actor,
          kind,
        });
        await client.views
          .update({
            view_id: viewId,
            view: buildMessageView(
              "Volunteer admin",
              "Something went wrong. Please try again.",
            ),
          })
          .catch(() => undefined);
      }
    });
  });

  const applyForm = async (
    client: SlackClient,
    meta: FormMetadata,
    values: StateValuesLike,
    actor: string,
  ): Promise<FormOutcome> => {
    const text = (blockId: string): string =>
      values[blockId]?.name?.value?.trim() ?? "";
    const date = (blockId: string): string | null =>
      values[blockId]?.date?.selected_date ?? null;
    const flags = (values[adminBlockIds.flags]?.flags?.selected_options ?? []).map(
      (selected) => selected.value,
    );
    const status = values[adminBlockIds.status]?.status?.selected_option?.value;
    const done = (result: AdminResult, field: string): FormOutcome => ({
      ...result,
      field,
    });
    const invalid = (message: string, field: string): FormOutcome => ({
      ok: false,
      message,
      field,
    });

    switch (meta.kind) {
      case "year": {
        const start = date(adminBlockIds.start);
        const end = date(adminBlockIds.end);

        if (!start) {
          return invalid("Choose a start date.", adminBlockIds.start);
        }

        if (!end) {
          return invalid("Choose an end date.", adminBlockIds.end);
        }

        const makeDefault = flags.includes("default");
        const result = meta.id
          ? await admin.updateYear(actor, meta.id, text(adminBlockIds.name), start, end, makeDefault)
          : await admin.addYear(actor, text(adminBlockIds.name), start, end, makeDefault);

        return done(
          result,
          /label/i.test(result.message) ? adminBlockIds.name : adminBlockIds.start,
        );
      }
      case "staff": {
        const user = meta.id ?? values[adminBlockIds.user]?.user?.selected_user;

        if (!user) {
          return invalid("Pick a Slack user.", adminBlockIds.user);
        }

        return done(
          await admin.setStaffMember(actor, {
            slackUserId: user,
            displayName: await lookupDisplayName(client, user),
            title: text(adminBlockIds.title) || null,
            canApprove: flags.includes("approve"),
            canManage: flags.includes("manage"),
            isPrimary: flags.includes("primary"),
          }),
          meta.id ? adminBlockIds.flags : adminBlockIds.user,
        );
      }
      case "category": {
        const result = meta.id
          ? await admin.updateCategory(actor, meta.id, {
              name: text(adminBlockIds.name),
              isActive: status ? status === "active" : null,
            })
          : await admin.addCategory(
              actor,
              text(adminBlockIds.name),
              flags.includes("requires_event"),
            );

        return done(result, adminBlockIds.name);
      }
      case "event": {
        if (!meta.id) {
          return done(
            await admin.addEvent(actor, text(adminBlockIds.name), date(adminBlockIds.date)),
            adminBlockIds.name,
          );
        }

        const updated = await admin.updateEvent(
          actor,
          meta.id,
          text(adminBlockIds.name),
          date(adminBlockIds.date),
        );

        if (!updated.ok || !status) {
          return done(updated, adminBlockIds.name);
        }

        const toggled = await admin.setEventActive(actor, meta.id, status === "active");

        return done(toggled.ok ? updated : toggled, adminBlockIds.name);
      }
      case "link": {
        const volunteerKey =
          values[adminBlockIds.volunteer]?.[adminActionIds.linkSearch]
            ?.selected_option?.value;
        const slackUser = values[adminBlockIds.user]?.user?.selected_user;

        if (!volunteerKey) {
          return invalid("Choose a volunteer.", adminBlockIds.volunteer);
        }

        if (!slackUser) {
          return invalid("Pick their Slack account.", adminBlockIds.user);
        }

        const result = await admin.linkVolunteerToSlack(actor, volunteerKey, slackUser);

        return {
          ...result,
          field: adminBlockIds.volunteer,
          ...(result.ok
            ? {
                after: async () => {
                  // Best effort: tell the volunteer their record is now theirs.
                  await client.chat
                    .postMessage({
                      channel: slackUser,
                      text: "✅ An admin linked your Slack account to your volunteer record. Your hours now show in /volunteer → My hours.",
                    })
                    .catch(() => undefined);
                },
              }
            : {}),
        };
      }
    }
  };

  app.view(ADMIN_FORM_CALLBACK, async ({ ack, body, client, view }) => {
    const meta = parseJsonMetadata<FormMetadata>(view.private_metadata);
    const actor = body.user.id;

    if (
      !meta.kind ||
      !formKinds.includes(meta.kind) ||
      typeof meta.back !== "string"
    ) {
      await ack({
        response_action: "update",
        view: buildMessageView(
          "Volunteer admin",
          "That form expired. Please run /volunteer-admin again.",
        ),
      });
      return;
    }

    const form: FormMetadata = {
      kind: meta.kind,
      back: meta.back,
      ...(meta.id ? { id: meta.id } : {}),
    };
    const fallbackField =
      form.kind === "staff"
        ? form.id
          ? adminBlockIds.flags
          : adminBlockIds.user
        : form.kind === "link"
          ? adminBlockIds.volunteer
          : adminBlockIds.name;

    const work: Promise<FormResult> = (async () => {
      const outcome = await applyForm(
        client,
        form,
        view.state.values as StateValuesLike,
        actor,
      );

      if (!outcome.ok) {
        return { errors: { [outcome.field]: outcome.message } };
      }

      return {
        view: await renderAdminScreen(admin, actor, form.back, outcome.message),
        after: async () => {
          await record(client, actor, `${form.kind}_save`, outcome.message);
          await outcome.after?.();
        },
      };
    })();

    let first;

    try {
      first = await settleWithin(work, ACK_BUDGET_MS);
    } catch (error) {
      logError("volunteer_admin_form_failed", error, { slackUserId: actor });
      await ack({
        response_action: "errors",
        errors: { [fallbackField]: "Something went wrong. Please try again." },
      });
      return;
    }

    if (first.settled) {
      if ("errors" in first.value) {
        await ack({ response_action: "errors", errors: first.value.errors });
        return;
      }

      await ack({ response_action: "update", view: first.value.view });
      await background("admin_after_save", first.value.after);
      return;
    }

    // Too slow to answer inside Slack's limit: show a holding screen, then
    // swap in the result when it arrives.
    await ack({ response_action: "update", view: buildLoadingView("Saving…") });

    await background("admin_form_late", async () => {
      let result: FormResult;

      try {
        result = await work;
      } catch (error) {
        logError("volunteer_admin_form_failed", error, { slackUserId: actor });
        await show(
          client,
          view.id,
          actor,
          form.back,
          "⚠️ Something went wrong. Please try again.",
        );
        return;
      }

      if ("errors" in result) {
        await show(
          client,
          view.id,
          actor,
          form.back,
          `⚠️ ${Object.values(result.errors).join(" ")}`,
        );
        return;
      }

      await client.views.update({ view_id: view.id, view: result.view });
      await result.after();
    });
  });
}
