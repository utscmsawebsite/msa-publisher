# Taking the volunteer bot live (no more `npm run dev:volunteers`)

Today the bot runs on your laptop in "Socket Mode", so it only works while that
terminal is open. Going live means the same code runs on Vercel, next to the
`/event` and `/jummah` bot, and Slack sends requests to it over the internet.

**Nothing here changes the `/event`, `/event-edit` or `/jummah` bot.** The
volunteer bot is its own Vercel function (`api/slack-volunteers.ts`), its own Slack
app and its own tables, and `src/application.ts` is untouched. If the volunteer
bot has a problem, events keep working.

Do the steps **in order**. Steps marked **you** involve your accounts or
secrets; nobody else should do them for you.

---

## Before you start (decisions)

1. **Your deployment address.** The host your `/event` Slack app already sends
   requests to (`https://<something>.vercel.app`). Find it in the existing Slack
   app's slash-command Request URL. It is needed in steps 4 and 6.
2. **Switch the dev app, don't make a second one.** The dev app is already in the
   community workspace with the same three commands. A second app with the same
   commands would clash. After the switch, the dev app *is* the live app, and the
   laptop bot stops working (that is the point).
3. **A fresh start.** The test branch has your test staff, years and requests.
   Production starts clean, with only the three categories (General, Jummah,
   Specific Event). You add the volunteer year and staff in Slack in step 8.

---

## 1. Apply the database migration to your real database (you)

This only **adds** new `volunteer_*` tables in one transaction. It does not
touch your existing tables, so a failure leaves nothing half-done.

First, check you are pointed at the real database, not the test branch. This
prints only the host names:

```bash
for f in .env .env.volunteers; do printf "%s -> " "$f"; grep '^DATABASE_URL=' "$f" | head -1 | cut -d= -f2- | tr -d "\"'" | sed -E 's#^[a-z]+://[^@]*@([^/?]+).*#\1#'; done
```

The two hosts must be **different**. `.env` is your real database; `.env.volunteers`
is the test branch. Then apply it to the real one (`.env`):

```bash
url=$(grep '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d "\"'"); case "$url" in postgres*) psql "$url" -v ON_ERROR_STOP=1 -f migrations/004_create_volunteer_tables.sql;; *) echo "DATABASE_URL in .env doesn't look like a postgres URL";; esac
```

You should see `CREATE TABLE ...` lines and `COMMIT`. If it says a table already
exists, stop and tell me: it was already applied, or the wrong database is in `.env`.

Confirm the tables are there (prints names only):

```bash
url=$(grep '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d "\"'"); case "$url" in postgres*) psql "$url" -At -c "select table_name from information_schema.tables where table_name like 'volunteer_%' order by 1";; esac
```

## 2. Get the three values from Slack (you)

In <https://api.slack.com/apps> -> your volunteer app:

- **Basic Information** -> **App Credentials** -> **Signing Secret** -> Show -> copy.
  This is `SLACK_VOLUNTEER_SIGNING_SECRET`. It is new; the local bot never needed it.
- **OAuth & Permissions** -> **Bot User OAuth Token** (`xoxb-...`). Same token as
  in `.env.volunteers`.
- The two channel IDs and your member ID are the same as in `.env.volunteers`.

## 3. Add the environment variables in Vercel (you)

Vercel dashboard -> your project -> **Settings** -> **Environment Variables**.
Add these for **Production** (paste the values yourself, never in chat):

| Name | Value |
| --- | --- |
| `SLACK_VOLUNTEER_BOT_TOKEN` | the `xoxb-...` token |
| `SLACK_VOLUNTEER_SIGNING_SECRET` | the signing secret from step 2 |
| `SLACK_VOLUNTEER_APPROVALS_CHANNEL_ID` | same as in `.env.volunteers` |
| `SLACK_VOLUNTEER_LOG_CHANNEL_ID` | same as in `.env.volunteers` |
| `SLACK_VOLUNTEER_ADMIN_USER_IDS` | your member ID (comma-separated for several admins) |

Do **not** add `SLACK_VOLUNTEER_APP_TOKEN` (that is only for the laptop bot).

`DATABASE_URL` is already there for the existing bot. Open it and check it is your
**real** database's host (not the `volunteers-test` host from step 1). The
volunteer bot reads the same variable.

Optional: `VOLUNTEER_ORG_NAME` (defaults to `UTSC MSA`) and
`VOLUNTEER_LETTERHEAD_CONTACT` (a contact line printed on letters).

## 4. Put the code on Vercel

This is the step that publishes the code, so it waits for your go-ahead. It is a
single commit on `main` made as `utscmsawebsite` (so Vercel's Hobby plan accepts
the deployment). It adds the volunteer code, tests and docs, plus these
dependencies: `pdf-lib`, `@pdf-lib/fontkit` and `dejavu-fonts-ttf` (report fonts).
`/api/slack`, `/api/jummah` and `/api/events` are unchanged.

When it is pushed, Vercel builds and deploys on its own. Watch **Deployments** in
Vercel until it says **Ready**. If the build fails, tell me what it says; nothing
else has changed yet, so nothing is broken.

## 5. Check the deployment is alive (you, optional)

Open this address in a browser:

```text
https://<your-deployment>/api/slack-volunteers
```

The function only accepts Slack's signed requests, so a plain visit shows an
error page (usually a Vercel "500" / "function invocation failed"). That is
expected and fine: it means the function exists. A Vercel **404 NOT_FOUND** means
it didn't deploy, so check the build in **Deployments**.

## 6. Switch the Slack app to the hosted version (you)

This is the moment the laptop bot stops mattering. It is quick, and only the
volunteer commands are affected.

1. **Stop the laptop bot**: `Ctrl+C` in the terminal running `npm run dev:volunteers`.
2. Copy [`docs/volunteer-slack-app.manifest.yml`](volunteer-slack-app.manifest.yml),
   replace every `https://YOUR-DEPLOYMENT.vercel.app` with your real address, and
   paste it into the app: **App Manifest** -> **YAML** -> **Save Changes**.
3. If Slack asks to **Reinstall**, do it. The bot token stays the same.
4. Check under **Slash Commands** that the Request URL is your address, and under
   **Interactivity & Shortcuts** that **Request URL** and **Options Load URL** are
   the same address. **Socket Mode** should now be off.

## 7. Smoke test, about 5 minutes (you)

In the community workspace, with nothing running on your laptop:

| Do | Expect |
| --- | --- |
| `/volunteer` | The home screen opens. |
| `/volunteer-admin` | The admin home opens. |
| **Staff** -> add yourself with all three permissions | ✅, and a line in the log channel. |
| **Years** -> **+ New year** (for example `2026/27 Volunteer Year`) | ✅ Added. |
| Log hours -> pick **Specific Event** | The Event dropdown appears. |
| **Log hours for someone** -> type in the search box | Matching people appear (this proves the Options Load URL). |
| Approve a request from the approvals channel | The card updates and the volunteer gets a DM. |
| `/volunteer-exec` -> **Volunteer letters** -> pick yourself | A PDF arrives in your DMs and **opens with readable text** (this proves the report fonts are bundled on Vercel). |

If a command says "could not be opened" or does nothing, look at the deployment's
logs: Vercel -> **Logs** -> filter on `/api/slack-volunteers`. Log lines are named
like `volunteer_hub_open_failed`. Send me those lines, never a token.

## 8. Set up for real (in Slack)

If you did the smoke test with real details, you are already done with these:

1. `/volunteer-admin` -> **Staff**: add each approver and exec (title, then
   permissions). Admins (the env list) can do everything; staff are the people
   who approve hours, manage setup, or sign letters.
2. **Years**: create the real volunteer year(s).
3. **Events**: add the events volunteers can pick for "Specific Event".
4. Tell volunteers to use `/volunteer` in the community workspace.

## 9. If something goes wrong (rollback)

- **Volunteer bot only is broken:** switch the app back to the laptop version:
  paste [`docs/volunteer-slack-app.dev.manifest.yml`](volunteer-slack-app.dev.manifest.yml)
  into **App Manifest** and run `npm run dev:volunteers`. The data stays in the
  database either way.
- **The deployment itself looks wrong:** Vercel -> **Deployments** -> an earlier
  one -> **Promote to Production** (or `git revert` the commit). Events are
  unaffected.
- The new tables are harmless if unused, so there is no need to undo the migration.

## 10. After it is live

- Delete the Neon `volunteers-test` branch when you no longer need it.
- Rename nothing: the display name is already `MSA Volunteer Hours` (the `(dev)`
  goes away with the new manifest).
- To test changes later without risking the live app, create a **separate dev app**
  from `docs/volunteer-slack-app.dev.manifest.yml` in a throwaway workspace and use
  `npm run dev:volunteers` with that app's own tokens and the test branch.

## Good to know

- **Slow first click.** After the function sits idle, the first command can take a
  couple of seconds. The bot opens a "Loading…" window before doing any database
  work for exactly this reason.
- **Settings take up to 30 seconds** to show up for volunteers after an admin
  changes categories or events (each server instance caches them briefly).
- **Hobby plan limits** are the same as for the existing bot: 300 seconds per
  request is plenty for a report.
