# Testing the volunteer bot in Slack

This runs the volunteer bot **on your own machine** in the Slack workspace you
choose to test in (the community workspace, or the exec one), against a
**separate Neon test branch**. Nothing is deployed, nothing
is pushed, and the live `/event` and `/jummah` bot is not touched: the volunteer
bot is its own Slack app with its own tokens and its own database branch.

You will do the account steps (Neon, Slack). They involve secrets, so they stay
with you. A check command then tells you, without printing any secret, whether
everything is set up right.

Total time: about 20 minutes.

---

## 1. Make a Neon test branch

A branch is a copy of your database that you can change freely. Changes to it
never reach your main database.

1. Open the [Neon console](https://console.neon.tech) and your project.
2. **Branches** -> **Create branch**. Name it `volunteers-test`, parent `main`.
3. Open the branch -> **Connect**. Under **Branch** choose `volunteers-test`,
   and copy the connection string (it starts with `postgresql://`).
4. Note the host in that string (`ep-something-123456.region.aws.neon.tech`). It
   must be **different** from your main branch's host. The check command in
   step 6 prints the host so you can compare.

## 2. Create the Slack app from the manifest

1. Go to <https://api.slack.com/apps> and click **Create New App** -> **Paste a
   manifest** (older Slack versions call it **From a manifest**).
2. Pick the workspace you are testing in (the community one) and click
   **Next**. Slash commands work in every channel and DM of that workspace, but
   only while your dev bot is running, so run it only while you test.
3. Choose the **YAML** tab, delete what is there, and paste the whole of
   [`docs/volunteer-slack-app.dev.manifest.yml`](volunteer-slack-app.dev.manifest.yml).
   Click **Next**, then **Create**.
4. You land on **Basic Information**. Scroll to **App-Level Tokens** ->
   **Generate Token and Scopes**. Name it `socket`, add the scope
   **`connections:write`**, click **Generate**, and copy the token. It starts
   with `xapp-`. This is `SLACK_VOLUNTEER_APP_TOKEN`.
5. In the left menu click **Install App** -> **Install to Workspace** ->
   **Allow**. Copy the **Bot User OAuth Token**. It starts with `xoxb-`. This is
   `SLACK_VOLUNTEER_BOT_TOKEN`.
6. Quick look: **Slash Commands** should list 3 commands (`/volunteer`, `/volunteer-exec`, `/volunteer-admin`), **Interactivity &
   Shortcuts** should be on, and **Socket Mode** should be on. The manifest set
   all of that, so you only need to glance.

### Updating the app's commands

If the app was created from an older manifest (it had seven commands, such as `/volunteer-hours`), change
it to the current three (`/volunteer`, `/volunteer-exec`, `/volunteer-admin`):
open the app at <https://api.slack.com/apps> -> **App Manifest** -> **YAML**,
replace everything with the current
[`docs/volunteer-slack-app.dev.manifest.yml`](volunteer-slack-app.dev.manifest.yml),
click **Save Changes**, and if Slack asks, **Reinstall**. Then stop the bot
(`Ctrl+C`), start it again with `npm run dev:volunteers`, and reload Slack
(Cmd+R) so the command list refreshes.

> **If "Install to Workspace" asks for admin approval**, someone with admin
> rights (Danish?) must approve it. If that is slow, make a free throwaway Slack
> workspace and do this guide there instead. It is the safest way to test, since
> nobody else is in it.

You do **not** need the Signing Secret for this local test.

## 3. Pick the channel and find your IDs

- **Approvals channel.** Use a private channel you control (in the exec
  workspace, `#msa-publisher-logs` is fine too). In that channel type `/invite @MSA Volunteer Hours` so the bot can post there. For
  a private channel this invite is required.
- **Channel ID.** Click the channel name -> **About**, scroll to the bottom, and
  copy the **Channel ID** (looks like `C0123456789`).
- **Your member ID.** Click your profile picture -> **Profile** -> the three
  dots -> **Copy member ID** (looks like `U0123456789`).

## 4. Create `.env.volunteers`

Create a file named `.env.volunteers` in the project folder. Use your editor
(not `echo`, which would put the secrets in your shell history). `touch` creates
the empty file first, because `open -e` can't open a file that doesn't exist:

```bash
touch .env.volunteers && open -e .env.volunteers
```

Paste this and fill it in:

```bash
# Neon TEST branch, not main
DATABASE_URL=postgresql://...

SLACK_VOLUNTEER_BOT_TOKEN=xoxb-...
SLACK_VOLUNTEER_APP_TOKEN=xapp-...
SLACK_VOLUNTEER_APPROVALS_CHANNEL_ID=C...
SLACK_VOLUNTEER_LOG_CHANNEL_ID=C...
SLACK_VOLUNTEER_ADMIN_USER_IDS=U...
```

Write each value with **no quotes** (TextEdit can turn straight quotes into
curly ones, which would break the file). If you have several admins, separate
their IDs with commas.

Using the same channel ID for approvals and the log is fine for testing. The
file is already ignored by git (`.env*` is in `.gitignore`).

**Why a separate file?** Your real database URL is in `.env`. The dev bot
refuses to start unless `.env.volunteers` provides its own `DATABASE_URL`, so a
test can never run against your real data by accident.

## 5. Apply the migration to the test branch

Do this only after step 6's check shows the **test branch's host** (run step 6
once first; it will tell you the tables are missing, which is expected).

```bash
url=$(grep '^DATABASE_URL=' .env.volunteers | head -1 | cut -d= -f2- | tr -d "\"'"); case "$url" in postgres*) psql "$url" -v ON_ERROR_STOP=1 -f migrations/004_create_volunteer_tables.sql;; *) echo "DATABASE_URL in .env.volunteers doesn't look like a postgres URL";; esac
```

(This reads the URL straight from the file instead of running `source` on it,
because a Neon URL contains `?` and `&`, which the shell would misread. It also
strips any quotes around the value, and refuses to run if the value isn't a
`postgres...` URL: `psql` prints the whole connection string, password
included, when it can't parse one, so never feed it a malformed value.)

You should see a series of `CREATE TABLE` / `CREATE INDEX` lines and `COMMIT`. It
only creates new tables, in one transaction, so a failure leaves nothing
half-done.

## 6. Run the check

```bash
npm run check:volunteers
```

It asks Slack whether both tokens work, then looks (read-only) at the test
database. It never posts anything and never prints a token, password or
connection string, so you can paste its output to me.

Before step 5 you should see ✅ for the tokens and IDs, and a ❌ saying the
tables aren't in the database yet. **After step 5 you should see only ✅ plus two
⚠️** ("No volunteer year yet" and "No staff yet"). Those two are fixed inside
Slack in step 8.

## 7. Start the bot

```bash
npm run dev:volunteers
```

It prints `Using database host: ...` (confirm it is the test branch) and then
`Volunteer hours Slack bot is running!`. **Leave this terminal open**: in Socket
Mode the bot only works while this process runs. Stop it with `Ctrl+C`. Watch
this terminal while you test; errors appear here.

## 8. First-time setup inside Slack

You are the only admin, so set yourself up as staff and add a volunteer year.

1. Type `/volunteer-admin` -> **Staff** -> **+ Add staff member**. Pick
   yourself, enter a title (for example `Automations Director`; it is printed
   under the signature on letters), tick **Exec**, **Admin** and **Primary approver**, click
   **Save**. The Staff list comes back with a ✅ line, and there is a line in the
   log channel.
2. **← Back**, then **Years** -> **+ New year**. Label `2026/27 Volunteer Year`,
   from `2026-09-01` to `2027-03-15` (or whatever dates you want). **Save**.
3. Optional: **Events** -> **+ Add event** -> `Test Iftar`, so you can try the
   "Specific Event" category.

Run `npm run check:volunteers` again. It should now be all ✅.

---

## 9. The test script (in presentation order)

One run-through, in the order that tells the story best: set up the year, a
volunteer logs hours, an exec reviews them, an admin fixes things, then reports.
About 30 minutes. "Expect" is what should happen; tell me about anything that
differs. Use obviously fake details for test volunteers (student number like
`1000000001`, UTORid like `testperson1`).

Marked 👀 are the screens I could not look at in real Slack myself (the tests
cover their logic, not how they look). Look at those most closely.

Tips for presenting:

- Keep the **approvals channel** open next to Slack so people see the cards and
  DMs change as you click.
- Do **Act 7** (permissions) last, or skip it. It removes your own approver
  rights for a moment.
- The terminal prints only the database host, never a token or password, so it is
  safe to have on screen.

### Act 0. Before you start

| # | Do | Expect |
| --- | --- | --- |
| 0.1 | Stop the bot (`Ctrl+C`) and start it again: `npm run dev:volunteers` | `Using database host: ...` (the test branch, not main), then `Volunteer hours Slack bot is running!`. Leave the terminal open. |
| 0.2 | `npm run check:volunteers` | Only ✅ (and the two ⚠️ "No volunteer year yet" / "No staff yet" only if this is a fresh branch). |
| 0.3 | Reload Slack (Cmd+R) | The command list shows exactly `/volunteer`, `/volunteer-exec`, `/volunteer-admin`. |

The test branch still holds what you added in earlier tests (staff, a year, an
event, maybe requests). That is fine: skip any "add" step whose thing already
exists.

### Act 1. The admin sets the stage (`/volunteer-admin`)

| # | Do | Expect |
| --- | --- | --- |
| 1.1 | `/volunteer-admin` | Three groups: **Volunteers** (Pending requests, Log hours for someone, Find a volunteer's requests, Link to a Slack account), **Reports and letters** (CCR report, Volunteer letters), and **Setup** with a one-line summary ("Current year: ... · N staff · 3 categories · N events") and **Years / Staff / Categories / Events**. |
| 1.2 | **Staff** -> **+ Add staff member** (or **Edit** if you are already listed). Pick yourself, title `Automations Director`, tick **Exec**, **Admin** and **Primary approver** -> **Save** | The Staff list returns with a ✅ line, and you are listed as "Exec · Admin · Primary approver". A line appears in the log channel. The list also has a one-line key explaining Exec and Admin. |
| 1.3 | **Edit** yourself, clear the title -> **Save**; edit again and put it back | The title is cleared, then restored. |
| 1.4 | **← Back** -> **Years** | One row per year: dates, ● Current / Past / Upcoming, and totals ("N volunteers · X h approved · Y h pending · Z h sent to CCR"). **+ New year** on top. |
| 1.5 | **+ New year**: `2027/28 Volunteer Year`, `2027-09-01` to `2028-03-15` -> **Save** | Back on the Years list with "✅ Added ...". |
| 1.5b | **Edit year** on a year, tick **Use as the default year** -> **Save** | The message ends "It is now the default year." The Years list and the year's page show **★ Default** on that year only, and the admin home summary says "Default year: ...". Ticking it on another year moves the tag; unticking it on the default year clears it. |
| 1.5c | Open **CCR report** or **Volunteer letters** from the home screen | The **Volunteer year** dropdown starts on the default year (the year containing today if none is set) and still lists every year. |
| 1.6 | **+ New year** again with the same label; then with dates that overlap another year | Red errors under the right field each time; nothing saved. |
| 1.7 | **Open** the current year (2026/27) | Its page: dates, totals, **Edit year**, **Generate a report**, and the events dated inside it, with **+ Add event**. |
| 1.8 | **+ Add event** -> name `Test Iftar` | The date is already filled in (inside the year). **Save** returns to the year page with the event listed. |
| 1.9 | **Edit** that event: rename it, move its date outside the year, set **Inactive** -> **Save** | Back on the year page; the event is gone from it. It is under **Events**, marked inactive. Put it back (active, date inside the year) for Act 2. |
| 1.10 | **Edit year** on the empty 2027/28 year -> **Delete this year** -> confirm | Back on the Years list with "✅ Deleted ...". (A year that has hours shows no delete button, only a note.) |
| 1.11 | **Categories** -> **+ Add category** (tick "must pick an event") -> **Save**; then **Edit** it and make it **Inactive** | It appears, then shows "inactive", and is gone from the log-hours form. |

### Act 2. A volunteer logs hours (`/volunteer`)

| # | Do | Expect |
| --- | --- | --- |
| 2.1 | `/volunteer` | Your totals (approved / pending / disapproved) and three buttons: **Log hours**, **My hours**, **My profile**. A grey line points to `/volunteer-exec` and `/volunteer-admin`. |
| 2.2 | **Log hours**. First time only: choose **UofT student** -> Next -> fill in -> **Save & continue** | The profile form, then the hours form straight away. If you already have a profile you land on the hours form at once (**My profile** is where you'd edit it). |
| 2.3 | In the hours form, try mistakes one at a time: 25 hours; the same date twice; the date `2025-01-01`; no description | A red error on the form each time ("isn't in a volunteer year yet" for the old date). Nothing is saved. |
| 2.3b 👀 | Pick **General** in Category, then **Specific Event** (what you typed stays), then **General** again. Finally pick **Specific Event** and submit without choosing an event | The **Event** dropdown is not on the form at first. It appears right after you pick Specific Event (listing the active events), is required, and disappears again for General. Submitting without an event shows a red "required" error on the dropdown. |
| 2.4 | Click **+ Add another date** three times, then **Remove last date** | Rows appear and disappear, and what you typed stays. |
| 2.5 | **Request 1:** General, a description, date `2026-11-14`, `2` hours -> **Submit** | **Saving…**, then "Got it! … pending approval" with **Log more hours** and **My hours**. A card appears in the approvals channel with **Approve / Disapprove**, no student number on it, and "Submitted by the volunteer". |
| 2.6 | **Request 2:** category **Specific Event** (then choose `Test Iftar` in the Event dropdown that appears), dates `2026-11-15` and `2026-11-16`, 1.5 h each. **Request 3:** General, `2026-11-17`, 1 h | Same result each time: confirmation plus a card in the channel. |
| 2.7 | `/volunteer` -> **My hours** | Pending 6 h at the top and one card per request with its dates, status, category and an **Edit** button. **← Back** returns to the home. |

### Act 3. The exec reviews (`/volunteer-exec`)

| # | Do | Expect |
| --- | --- | --- |
| 3.1 | `/volunteer-exec` | "3 requests are waiting for review" and a highlighted **Pending requests (3)** button, then **CCR report** and **Volunteer letters**. |
| 3.2 👀 | **Pending requests** | One card per request, longest-waiting first: volunteer, dates, hours, category, what was done, when submitted. **Approve** and **Disapprove** under each. |
| 3.3 | **Approve** request 1 | The queue redraws with "✅ Approved … h" at the top and that request gone. The channel card becomes Approved; the volunteer gets an "approved" DM. |
| 3.4 | **Disapprove** request 2. Submit the reason empty, then with a reason | The reason form replaces the queue, with **← Back**. Empty: an error. With a reason: the queue returns with "Disapproved …", the channel card updates, and the DM shows the reason. |
| 3.5 | In the **approvals channel**, click **Approve** on request 3's card | Card becomes "Approved by you"; you get an "approved" DM. |
| 3.6 | `/volunteer` -> **My hours**. Request 2's card shows the reason ("↳ …"). **Edit** it, change the hours -> **Save changes** | After saving: Saving…, a confirmation, and the request is pending again with the reason cleared. The channel card shows "Edited by you" with **Approve/Disapprove back**. |
| 3.7 | **Edit** an **approved** request (request 1), change the hours to `3` -> **Save changes** | The form says the change "goes back to the approvers". After saving the card is pending again; approve it again from the channel: approved at 3 h. |
| 3.8 *(optional, needs two windows)* | Open the queue in one window; approve the same request on its channel card in another; then press **Approve** in the first | "⚠️ That request was already approved by …" and the queue refreshes. |

### Act 4. The admin handles a volunteer who isn't on Slack

| # | Do | Expect |
| --- | --- | --- |
| 4.1 👀 | `/volunteer-admin` -> **Log hours for someone** | A search box ("Search by name, UTORid, student number or email") and a **+ New volunteer** button. No Next button. |
| 4.2 | **+ New volunteer** -> **High school student** -> Next -> fake details -> **Save & continue** -> add hours -> **Submit** | Saving…, then "Logged and approved…" with **Log hours for someone else** and **Admin home**. The channel card reads "Entered by you on the volunteer's behalf", shows **No Slack account**, and is **already approved with no buttons**. |
| 4.3 | **Log hours for someone** -> type the fake name | They appear with "· no Slack". Pick them: the hours form opens at once with "Entering this for … (not on Slack)". **← Back** returns to the search. |
| 4.4 | **+ New volunteer** again with the **same student number** | An error naming the existing person and telling you to search for them. |
| 4.5 👀 | **Find a volunteer's requests** -> pick the fake volunteer | Their requests as cards with **Edit**. Each **pending** request also has **Approve** and **Disapprove** buttons if you are staff with the **Exec** role (none under approved or disapproved ones, and none at all for someone who can't approve). **Edit** opens the form: "your change takes effect right away". |
| 4.5b 👀 | On that list, press **Approve** on a pending request. Then press **Disapprove** on another | Approve: the same list redraws with "✅ Approved ...", that request shows Approved and loses its buttons, the channel card becomes "Approved by you", and the volunteer gets a DM. Disapprove: the list is replaced by a reason form with **← Back**; empty is refused; with a reason the list returns with "Disapproved ...", the card shows the reason, and the DM includes it. |
| 4.6 | Change the hours -> **Save changes** | Saving…, then a confirmation with **Back to their requests**. The channel card updates and stays approved ("Edited by you"); a line in the log channel. |
| 4.7 | Open it again, tick **Delete this whole request instead** -> **Save changes** | The card is replaced by "Deleted by you"; the request is gone from their list; a line in the log channel. |

### Act 5. Reports and letters

| # | Do | Expect |
| --- | --- | --- |
| 5.1 | `/volunteer-exec` -> **CCR report** -> current year, **UofT students only**, **Only entries not yet sent**, by name -> Generate | A DM with a CSV and a PDF, and a **Mark N entries as sent to CCR** button. Open both: no letter fields in the report. |
| 5.2 | `/volunteer-exec` -> **Volunteer letters** -> current year, search for yourself in **Volunteers** -> Generate | The form asks only for the year and the volunteers. A DM with a letter PDF: MSA logo, your hours table, and **your name and title** under the signature line. |
| 5.3 | Click **Mark N entries as sent to CCR**, confirm | The message becomes "✅ Marked N entries as sent to CCR by you on <date>". Generate the report again with "not yet sent": those entries are gone. |
| 5.4 | `/volunteer` -> **My hours**, look at a sent request | Its card says "Sent to CCR" and has no **Edit** button. |
| 5.5 | `/volunteer-admin` -> **Years** -> **Open** the year -> **Generate a report** -> **← Back** | The report form opens on that year; Back lands on that year's page. |
| 5.6 | On that year page: **Edit year**, move the start date past a logged date | An error: "N logged date(s) would fall outside those dates". Renaming the year works. |

### Act 6. Polish checks

| # | Do | Expect |
| --- | --- | --- |
| 6.1 | From each home (`/volunteer`, `/volunteer-exec`, `/volunteer-admin`) open every button | Each first screen has **← Back** at the top, and it returns to the home you came from. |
| 6.2 | Open **Edit** on a request, then **+ Add another date** | **← Back** is still there and goes back to the list you came from. |
| 6.3 | **Find a volunteer's requests** -> pick -> **Edit** -> **← Back** | On that volunteer's cards (not the home); **← Back** again reaches the admin home. |
| 6.4 | `/volunteer-admin` -> **Pending requests**: approve one, then **← Back** | Lands on the admin home, not the exec home. (Needs one pending request: submit another from Act 2.) |
| 6.5 | Any screen: **Close** | The whole window closes. That is expected; **← Back** steps back. |
| 6.6 | Save any form, then watch the window | Saving… then a confirmation with next-step buttons. The window never just vanishes. |

### Act 7. Permissions (do last, or skip)

| # | Do | Expect |
| --- | --- | --- |
| 7.1 | `/volunteer-admin` -> **Staff** -> **Edit** yourself -> **Remove from staff** (you stay admin through the env list) | Removed. |
| 7.2 | Submit a request, then click **Approve** on its card | A private "You don't have permission to approve volunteer hours" message, and a ⚠️ line in the log channel. |
| 7.3 | `/volunteer-exec` -> **CCR report** | Still opens, because your ID is in the admin list and admins get everything execs get. |
| 7.4 | Add yourself back (step 1.2) with Exec, Admin and Primary approver ticked | Everything works again. |

### Things you can't test alone

- **Linking a Slack account to an exec-added record.** It needs a second Slack
  account signing in with matching details. It is covered by the automated tests
  and the real-database test. To see it live, add a second account (for example
  a personal email) to the workspace.
- **A member or exec being refused** by `/volunteer-exec` or `/volunteer-admin`,
  and by the forms behind them, since your admin ID makes you all three. Also
  **a manage-only exec** (sees the queue without Approve buttons), **two
  approvers clicking at once**, and **an approver clicking a card that was just
  edited.** All covered by tests.
- **`expired_trigger_id` after the app sits idle.** That is a hosted-on-Vercel
  cold-start issue; the local bot never goes cold.

---

## 10. What to send me if something is off

- The output of `npm run check:volunteers` (safe: no secrets).
- The error lines from the terminal running `npm run dev:volunteers`. Log lines
  are named like `volunteer_hours_submit_failed`.
- A screenshot of what you saw in Slack, and which step in the table above.

Never paste a token or a connection string.

## 11. Troubleshooting

| You see | Likely cause and fix |
| --- | --- |
| A command fails with "dispatch_failed" or `operation_timeout` | The bot isn't running, or the terminal was closed. Run `npm run dev:volunteers` and leave it open. |
| A command isn't recognised | The app isn't installed in this workspace, or its command list is out of date. Paste the current manifest (see "Updating the app's commands" in step 2), then **Install App** -> **Reinstall to Workspace**. |
| "Sorry, /volunteer-… could not be opened" in Slack | Slack refused the screen. The terminal running the bot says why: lines starting `[ERROR] bolt-app` (for example "action_id … already exists") and `invalid_arguments`. Send me those lines. If you just updated the code, stop the bot (`Ctrl+C`) and run `npm run dev:volunteers` again, since it doesn't reload on its own. |
| `not_in_channel` or `channel_not_found` in the terminal | The bot wasn't invited to the approvals channel (`/invite @MSA Volunteer Hours`), or the channel ID is wrong. |
| `missing_scope` | Scopes changed after installing. **Reinstall to Workspace**. |
| `invalid_auth` / `not_authed` | A token is wrong or old. Re-copy it into `.env.volunteers`, then restart the bot. |
| "Volunteer hours aren't set up yet" | No volunteer year or category. Step 8.2. |
| "You don't have permission…" when approving | You aren't in the staff list with **can approve**. Step 8.1. |
| No DM arrives | Look under **Apps** in the Slack sidebar for "MSA Volunteer Hours". Check the scope `im:write`, and reinstall if you changed it. |
| The search box shows nothing | Type at least one letter. Check the terminal for `volunteer_search_failed`. |
| No file arrives from `/volunteer-exec` -> **CCR report** or **Volunteer letters** | Scope `files:write` missing: reinstall. Check the terminal for `volunteer_report_`. |
| The bot says it won't start because of the database | That is the safety rule. Make sure `.env.volunteers` has its own `DATABASE_URL`. |

## 12. When you are done

1. Stop the bot with `Ctrl+C`.
2. In Neon, delete the `volunteers-test` branch (or keep it for the next round).
3. The Slack app can stay for later testing, and at go-live you switch this same
   app to the Vercel address instead of installing a second one (see the header
   of the manifest file). To remove it, open it at
   <https://api.slack.com/apps> -> **Basic Information** -> **Delete App**.
4. Nothing from this test exists in production. The real rollout (the community
   workspace, the HTTP deployment, and applying the migration to your main
   database) is a separate step that only happens when you say so.
