import { logError, logWarning } from "../logging/application-logger.js";
import type { VolunteerServices } from "../volunteer-application.js";
import type { SlackClient, VolunteerSlackContext } from "./volunteer-context.js";
import { loadAdminContext, renderAdminScreen } from "./volunteer-admin-handlers.js";
import {
  buildAdminHomeView,
  buildExecHomeView,
  buildMemberHomeView,
  hubActionIds,
  parseHubBack,
  type HubHome,
  type HubTier,
} from "./volunteer-hub-views.js";
import {
  buildLoadingView,
  buildMessageView,
  type ModalView,
} from "./volunteer-views.js";

type Flow = (
  client: SlackClient,
  viewId: string,
  userId: string,
  home?: HubHome,
) => Promise<void>;

/** The forms and lists the home-screen buttons lead to. */
export interface VolunteerFlows {
  beginHours: Flow;
  beginHoursFor: Flow;
  beginProfile: Flow;
  beginMyHours: Flow;
  beginRecords: Flow;
  beginReport: Flow;
  beginLetters: Flow;
  /** The approvers' queue; `notice` is shown at the top. */
  beginPending: (
    client: SlackClient,
    viewId: string,
    userId: string,
    home?: HubHome,
    notice?: string | null,
  ) => Promise<void>;
  /** One volunteer's requests as cards (an admin's lookup). */
  showRecordsFor: (
    client: SlackClient,
    viewId: string,
    userId: string,
    volunteerKey: string,
  ) => Promise<void>;
}

/**
 * Registers the three commands (/volunteer, /volunteer-exec, /volunteer-admin)
 * and the buttons on their home screens. Every form behind a button checks the
 * caller's permission again itself, so a button that is shown to the wrong
 * person (or a stale screen) still can't do anything.
 */
export function registerVolunteerHubs(
  context: VolunteerSlackContext,
  services: VolunteerServices,
  flows: VolunteerFlows,
): void {
  const { app, background, opsLog } = context;

  const tierOf = async (userId: string): Promise<HubTier> => {
    const [isAdmin, isExec] = await Promise.all([
      services.admin.canManage(userId),
      services.reports.canUseReports(userId),
    ]);

    return { isAdmin, isExec: isExec || isAdmin };
  };

  const memberHome = async (userId: string): Promise<ModalView> => {
    const [myHours, tier] = await Promise.all([
      services.volunteer.getMyHours(userId),
      tierOf(userId),
    ]);

    return buildMemberHomeView(myHours, tier);
  };

  const execHome = async (
    client: SlackClient,
    userId: string,
  ): Promise<ModalView> => {
    if (!(await tierOf(userId)).isExec) {
      logWarning("volunteer_authorization_denied", {
        slackUserId: userId,
        action: "/volunteer-exec",
      });
      await opsLog(
        client,
        `⚠️ Unauthorized /volunteer-exec attempt rejected\nUser: <@${userId}>`,
      );

      return buildMessageView(
        "Volunteer exec",
        "Only volunteer execs and admins can open this. Use /volunteer for your own hours.",
      );
    }

    const queue = await services.volunteer.getPendingQueue(userId);

    return buildExecHomeView(queue?.total ?? 0);
  };

  const adminHome = async (
    client: SlackClient,
    userId: string,
  ): Promise<ModalView> => {
    if (!(await tierOf(userId)).isAdmin) {
      logWarning("volunteer_authorization_denied", {
        slackUserId: userId,
        action: "/volunteer-admin",
      });
      await opsLog(
        client,
        `⚠️ Unauthorized /volunteer-admin attempt rejected\nUser: <@${userId}>`,
      );

      return buildMessageView(
        "Volunteer admin",
        "Only volunteer admins can open this. Use /volunteer for your own hours.",
      );
    }

    return buildAdminHomeView(await loadAdminContext(services.admin, userId));
  };

  const registerHub = (
    command: string,
    title: string,
    home: (client: SlackClient, userId: string) => Promise<ModalView>,
  ): void => {
    app.command(command, async ({ ack, command: payload, client, respond }) => {
      await ack();

      await background("hub_open", async () => {
        try {
          // Opens before any database work so the trigger_id can't expire.
          const opened = await client.views.open({
            trigger_id: payload.trigger_id,
            view: buildLoadingView(title),
          });
          const viewId = opened.view?.id;

          if (!viewId) {
            throw new Error("views.open did not return a view id.");
          }

          await client.views.update({
            view_id: viewId,
            view: await home(client, payload.user_id),
          });
        } catch (error) {
          logError("volunteer_hub_open_failed", error, {
            slackUserId: payload.user_id,
            command,
          });
          await respond({
            response_type: "ephemeral",
            text: `Sorry, ${command} could not be opened. Please try again.`,
          });
        }
      });
    });
  };

  registerHub("/volunteer", "Volunteer hours", (_client, userId) =>
    memberHome(userId),
  );
  registerHub("/volunteer-exec", "Volunteer exec", execHome);
  registerHub("/volunteer-admin", "Volunteer admin", adminHome);

  const buttons: Record<string, { title: string; run: Flow }> = {
    [hubActionIds.hours]: { title: "Log hours", run: flows.beginHours },
    [hubActionIds.myHours]: { title: "My hours", run: flows.beginMyHours },
    [hubActionIds.profile]: { title: "Volunteer profile", run: flows.beginProfile },
    [hubActionIds.report]: { title: "CCR report", run: flows.beginReport },
    [hubActionIds.letters]: { title: "Volunteer letters", run: flows.beginLetters },
    [hubActionIds.pending]: {
      title: "Pending requests",
      run: (client, viewId, userId, home) =>
        flows.beginPending(client, viewId, userId, home),
    },
    [hubActionIds.hoursFor]: {
      title: "Log hours for someone",
      run: flows.beginHoursFor,
    },
    [hubActionIds.records]: {
      title: "Volunteer requests",
      run: flows.beginRecords,
    },
  };

  const parseHome = (value: string | undefined): HubHome | undefined =>
    value === "member" || value === "exec" || value === "admin" ? value : undefined;

  app.action(/^vol_hub_/, async ({ ack, action, body, client }) => {
    await ack();

    // These buttons live on modal screens, so the modal to update is the
    // screen the button was clicked on.
    const viewId = "view" in body && body.view ? body.view.id : undefined;
    const userId = body.user.id;
    // A ":2" suffix only exists to keep two same-kind buttons in one row apart
    // (see buildDoneView); the button's kind is the part before it.
    const actionId =
      "action_id" in action ? action.action_id.split(":")[0] : undefined;
    const value = "value" in action ? action.value : undefined;

    if (!viewId || !actionId) {
      return;
    }

    await background("hub_action", async () => {
      if (actionId === hubActionIds.back) {
        const back = parseHubBack(value);

        try {
          if (back === "my") {
            await flows.beginMyHours(client, viewId, userId);
          } else if (back === "pending" || back === "pending:admin") {
            await flows.beginPending(
              client,
              viewId,
              userId,
              back === "pending:admin" ? "admin" : "exec",
            );
          } else if (back === "behalf") {
            await flows.beginHoursFor(client, viewId, userId, "admin");
          } else if (back.startsWith("admin:")) {
            await client.views.update({
              view_id: viewId,
              view: await renderAdminScreen(services.admin, userId, back.slice("admin:".length)),
            });
          } else if (back.startsWith("records:")) {
            await flows.showRecordsFor(client, viewId, userId, back.slice("records:".length));
          } else {
            await client.views.update({
              view_id: viewId,
              view:
                back === "exec"
                  ? await execHome(client, userId)
                  : back === "admin"
                    ? await adminHome(client, userId)
                    : await memberHome(userId),
            });
          }
        } catch (error) {
          logError("volunteer_hub_back_failed", error, { slackUserId: userId });
        }
        return;
      }

      const target = buttons[actionId];

      if (!target) {
        return;
      }

      try {
        await client.views.update({
          view_id: viewId,
          view: buildLoadingView(target.title),
        });
        await target.run(client, viewId, userId, parseHome(value));
      } catch (error) {
        logError("volunteer_hub_action_failed", error, {
          slackUserId: userId,
          action: actionId,
        });
        await client.views
          .update({
            view_id: viewId,
            view: buildMessageView(
              target.title,
              "Sorry, something went wrong. Please run the command again.",
            ),
          })
          .catch(() => undefined);
      }
    });
  });
}
