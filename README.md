# MSA Publisher

MSA Publisher is a centralized content and publishing platform for managing MSA events, meetings, Jummah information, and other content.

Instead of manually updating Slack, Instagram, WhatsApp, Google Calendar, and the MSA website independently, MSA Publisher allows authorized team members to create and manage content through Slack.

The goal is to sync MSA content sources while reducing repetitive work. This will prevent our platforms (particularly the website) from becoming outdated.

---

# Architecture

<img width="1672" height="941" alt="image" src="https://github.com/user-attachments/assets/1d0712b6-446c-4dd9-b087-de40f75d353a" />

### Slack + Bolt

Slack acts as the primary interface for MSA staff.

Commands such as:

```text
/event
/event-edit
/meeting
/jummah
```

open Slack modals where users can enter structured information.

Bolt handles Slack-specific functionality such as:

* Slash commands
* Modals
* Buttons and interactions
* Slack request handling
* Responses and confirmations

Bolt should remain a thin interface layer. Business logic should live in backend services rather than directly inside Slack command handlers.

### TypeScript Backend

The main application backend is written in TypeScript and deployed using Vercel serverless functions.

It is responsible for:

* Validating content
* Applying business rules
* Reading/writing Neon Postgres data
* Uploading original media to Vercel Blob
* Managing publishing
* Calling platform adapters
* Handling permissions
* Returning publishing results to Slack

### Neon Postgres + Vercel Blob

Neon Postgres is the canonical source of truth for MSA content and metadata.
Original image files are stored without transformation in Vercel Blob. Each
event stores an ordered array of its public Blob URLs in a single Postgres row.

The website should retrieve content through the TypeScript backend rather than
maintaining its own separate event or Jummah data.

For example:

```text
Slack
  ↓
Backend
  ↓
Neon Postgres
  ↑
Backend API ← Website
```

Once an event is stored in Neon, the website can automatically display it
without requiring a separate website update. Public event images are delivered directly from Vercel Blob URLs.

### HTTP API

The Vercel deployment exposes three independent serverless functions from the
same project:

```text
POST /api/slack   Slack commands and interactive payloads
GET  /api/events  Public events currently visible on the website
GET  /api/jummah  Current Jummah schedule for the website
```

`GET /api/events` returns events whose event date is today or later, ordered by
their date and start time. Internal Slack user IDs are not included in the
public response.

Successfully saving or editing an event also performs opportunistic cleanup:
event rows dated before the current Toronto date and their Blob images are
removed. This keeps stale content bounded without requiring a scheduled job.

`GET /api/jummah` returns the single current Jummah schedule and its current
availability. `isOffered` determines whether the website should show the
schedule or `unavailableMessage`. The saved schedule remains available while
`isOffered` is false, and the second Jummah fields are `null` when there is no
second khutbah.

Local development continues to use Socket Mode:

```bash
npm run dev
```

Production uses Slack's signed HTTP requests. Configure these environment
variables in Vercel:

```text
SLACK_BOT_TOKEN
SLACK_SIGNING_SECRET
SLACK_ALLOWED_USER_IDS
SLACK_LOG_CHANNEL_ID
DATABASE_URL
BLOB_READ_WRITE_TOKEN
GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL
GOOGLE_CALENDAR_SERVICE_ACCOUNT_PRIVATE_KEY
GOOGLE_CALENDAR_ID
```

`SLACK_ALLOWED_USER_IDS` is a comma-separated allowlist of Slack member IDs,
for example `U012ABCDEF,U098ZYXWVU`. Only those users can open or submit the
event, event-edit, and Jummah forms.

`SLACK_LOG_CHANNEL_ID` identifies the private operations channel that receives
event and Jummah successes, failures, and rejected authorization attempts. Add
the bot to that channel and grant it the `chat:write` bot scope.

`SLACK_APP_TOKEN` is only required for local Socket Mode. After deploying, use
the production `/api/slack` URL for the `/event`, `/event-edit`, and `/jummah`
command Request URLs and the Interactivity Request URL, then disable Socket
Mode.

### Google Calendar Sync

Successfully creating, editing, or deleting an event, and updating Jummah,
also syncs a shared **UTSC MSA Community Calendar**. Events map one-to-one to
calendar entries. Jummah maps to up to two weekly recurring events (first and
second khutbah) that repeat every Friday. Marking Jummah unavailable
overrides only that week's occurrence of the first Jummah to "No Jummah on
Campus" (with the given reason) and cancels that week's second-khutbah
occurrence if one exists; the underlying weekly schedule is preserved and
resumes automatically the next time `/jummah` is saved.

Calendar sync failures never block or roll back the underlying save — they
are logged and reported to `SLACK_LOG_CHANNEL_ID` as a warning, matching how
Blob cleanup failures are already handled.

Authentication uses a Google service account rather than a user's Gmail
login, so there's no OAuth consent flow or refresh tokens to maintain:

```text
GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL
GOOGLE_CALENDAR_SERVICE_ACCOUNT_PRIVATE_KEY
GOOGLE_CALENDAR_ID
```

One-time setup (whoever holds the Google Cloud project):

1. Create/reuse a Google Cloud project and enable the **Google Calendar API**.
2. Create a service account and generate a JSON key. Use its `client_email`
   as `GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL` and its `private_key` as
   `GOOGLE_CALENDAR_SERVICE_ACCOUNT_PRIVATE_KEY` (keep the `\n` escapes as-is;
   they are unescaped at runtime).
3. In Google Calendar, share the target calendar with the service account's
   email address, granting **"Make changes to events"** access.
4. Set `GOOGLE_CALENDAR_ID` to that calendar's ID (Calendar Settings →
   Integrate calendar → Calendar ID).

### Volunteer Hours

A separate Slack app, installed in the **community-volunteering workspace**
(not the exec workspace), lets volunteers log hours and approvers sign them
off. It runs from the same repo and the same Neon database but is its own
serverless function (`api/slack-volunteers.ts`) with its own tokens, so it
never affects `/event` or `/jummah`.

Commands:

```text
/volunteer         Everyone. Home screen: Log hours (first run sets up your
                   profile), My hours (a card per request with Edit), My profile
/volunteer-exec    Execs (staff who can approve or manage) and admins:
                   Pending requests (approve or disapprove from a queue),
                   CCR report (combined CSV + PDF), Volunteer letters
/volunteer-admin   Admins (can manage, or listed in SLACK_VOLUNTEER_ADMIN_USER_IDS).
                   Everything execs get, plus: Log hours for someone, Find a
                   volunteer's requests (fix or delete), and setup (staff,
                   categories, events, years, link a volunteer to Slack)
```

Each command opens a home screen of buttons. A button replaces the screen with
the form or list it leads to. Higher roles can use the lower commands too.

Flow: a volunteer picks a category and adds one or more dates with hours (max
24 h per person per day). A card with Approve / Disapprove buttons is posted
to a private approvals channel. Any approver can decide (self-approval is
allowed); disapproving requires a reason. The volunteer gets a DM either way
and, if disapproved, can fix the request from `/volunteer` -> **My hours** instead of starting
over. Entries must fall inside a volunteer year.

### Volunteer records and student numbers

A volunteer is identified by their **student number**, not by their Slack
account, and a profile follows the MSA general volunteer sign-up form by
student type:

| Student type | Fields |
| --- | --- |
| UofT student | first name, last name, preferred email, UofT email, UTORid, student number |
| University student outside UofT | first name, last name, preferred email, university email, university student ID |
| High school student | first name, last name, preferred email, email, student number |

The preferred email (asked of everyone on the first page of the form) is stored
for contacting the volunteer. The email from the volunteer's own section is the
one used for matching and in the reports.

The student number is unique per student type (case-insensitive), and a
UTORid is unique too. Phone numbers, emergency contacts and parent/guardian
details from the sign-up form are not collected here, since hours reporting
doesn't use them.

### Fixing mistakes: editing and deleting requests

Nothing is deleted and re-entered. A request is edited in place (category,
event, description, and the dates and hours; dates can be added or dropped).

| Who | How | What happens |
| --- | --- | --- |
| The volunteer | `/volunteer` -> **My hours** -> **Edit** on the request's card (pending, approved or disapproved) | The request goes **back to pending** and an approver reviews it again. The approval card is updated and the approvers are nudged in its thread. |
| An exec | `/volunteer-admin` -> **Find a volunteer's requests** -> pick the volunteer -> **Edit** on one of their request cards | The change is **approved immediately**. The volunteer is told. |
| An exec | the same form, "Delete this whole request instead" | The request and its dates are deleted, for example hours entered for the wrong person. Execs only. |

Rules:

- **Locked once sent to CCR.** If any hour in a request was marked as sent to
  CCR, nobody can edit or delete it (the report already went out). An exec logs
  a correction as a new entry instead.
- **Edits don't count against themselves.** The 24 hour daily cap ignores the
  request being edited, but counts everything else.
- **Approved hours leave the reports while they wait.** When a volunteer edits
  approved hours, the request is pending again until an approver approves it,
  so it drops out of reports in the meantime.
- **A no-op edit changes nothing,** so saving without changes never reopens
  approved hours.
- **Everything is recorded.** Every edit and deletion writes a row to
  `volunteer_submission_changes` with who did it, when, and the request before
  and after. The record survives a deleted request, and the log channel gets a
  line when an exec changes someone else's hours.
- A request keeps its own category and event even if an exec later deactivates
  them, so fixing hours never forces a change.
- **An approver can't approve hours they didn't see.** Each Approve and
  Disapprove button carries the version of the request the card showed. If the
  request is edited while an approver is looking at the old card, their click is
  refused ("that request was just edited"), the card is refreshed, and they
  decide again on the new hours.

Seeing records: volunteers see only their own (`/volunteer` -> **My hours**). Execs (staff with
the manage permission, plus the `SLACK_VOLUNTEER_ADMIN_USER_IDS` users) can look
up any volunteer with `/volunteer-admin` -> **Find a volunteer's requests**, and staff can generate reports.
Permissions live in the `volunteer_staff` table (`can_approve`, `can_manage`),
not in Slack roles, and are managed in `/volunteer-admin`.

### Logging hours for someone else (execs)

Every request records who submitted it. Execs (staff with the manage
permission, plus the `SLACK_VOLUNTEER_ADMIN_USER_IDS` users) can use
`/volunteer-admin` -> **Log hours for someone** to log hours for a volunteer, including one with no
Slack account. They choose exactly one of:

- **Find a volunteer**: search by name, UTORid, student number or email.
- **Add them as a new volunteer**: enter the same details as for any
  volunteer. The record is stored under an `ext_...` placeholder key until the
  volunteer is on Slack.

Because an exec entered the hours, **they are approved on entry**: no second
approver is needed. The exec is recorded as both submitter and approver, and a
card (without buttons) is still posted to the approvals channel as a record,
reading "Entered by @exec on the volunteer's behalf". A volunteer on Slack is
DM'd and sees "(entered by staff)" in `/volunteer` -> **My hours**; a volunteer without Slack
just isn't messaged. An existing volunteer's details are never overwritten this
way.

**When that volunteer later joins Slack.** If they run `/volunteer` -> **Log hours** and
enter details that match the record an exec added, their Slack account is
linked to it automatically and the hours carry over. The match is strict. It
needs the student number **and** a second identifier to agree (UTORid for UofT
students, email for everyone else), and the record must not already belong to a
Slack account. Linking is a single database statement (`ON UPDATE CASCADE`
moves the submissions), so if two accounts claim the same record, exactly one
wins. Anything weaker is refused with a message, and an exec can resolve it
from `/volunteer-admin` -> **Link a volunteer to a Slack account**. Two
existing records are never merged automatically.

Reports and letters (`/volunteer-exec`, execs and admins) are two separate
forms. Only approved hours are exported, and the files are sent to the
requester in a DM (nothing is hosted publicly):

- **CCR report** (a combined CSV + PDF). Pick a volunteer year, which students
  to include (UofT only by default, since CCR is UofT-specific), whether to
  include only entries not yet sent to CCR, a sort (by name or by date), and
  optionally limit it to chosen volunteers. The CSV has a UTF-8 BOM so Excel shows accented names
  correctly, and cells starting with `= + - @` are prefixed with `'` so
  volunteer-typed text can't run as a spreadsheet formula.
- **Volunteer letters** (the Volunteer letters form: a year and the volunteers),
  one letterhead PDF per selected volunteer, listing all of their approved hours. Each letter has the MSA logo and is signed with the
  name and title of the staff member who generates it (taken from their staff
  record, so set a title for anyone who will make letters).

Generating a combined report does not change anything. The message with the
files has a **Mark entries as sent to CCR** button; only after pressing it are
those entries stamped, so the next "not yet sent" export skips them and picks
up anything approved later. Every generation is logged in
`volunteer_report_exports`, with the entries each one included.

Admin (`/volunteer-admin`): admins (`can_manage`, or listed in
`SLACK_VOLUNTEER_ADMIN_USER_IDS`) get a home screen with Volunteers (log hours
for someone, find a volunteer's requests, link a volunteer to Slack), Reports
and letters, and Setup. Setup has four sections, each a list with an Edit
button per row, a **+ Add** button and a **Back** button:

- **Years:** each year shows its dates, whether it is current, past or
  upcoming, and its totals (volunteers, approved, pending and sent-to-CCR
  hours). A year's page lists the events whose date falls inside it, and has
  **Edit year**, **Generate a report** and **+ Add event**. Years are not
  seeded: an admin creates each one (for example `2026/27 Volunteer Year`).
  Volunteers can only log dates inside a year that exists. A year can always
  be renamed; its dates can only change while every date already logged stays
  inside them (the database enforces this inside the update); and it can be
  deleted only while nothing is logged against it and no report used it.
- **Staff:** add, edit (title, permissions) or remove. Limited to the Slack IDs
  in `SLACK_VOLUNTEER_ADMIN_USER_IDS`. A blank title clears it.
- **Categories:** add (optionally "must pick an event"), rename, deactivate.
- **Events:** the "Specific Event" pick-list: add, rename, change the date,
  deactivate.

Every change is posted to the log channel. These screens are gated by the staff
table, not by channel, and every button re-checks permission when it is
pressed, so they work from any channel or DM but not for anyone who has lost
access.

Setup (one time). For a dev app in any workspace, paste
`docs/volunteer-slack-app.dev.manifest.yml` at api.slack.com/apps -> Create New
App -> From a manifest; the steps below are the manual equivalent for production.

To take a tested dev app live on Vercel, follow
[docs/volunteer-go-live.md](docs/volunteer-go-live.md); its production manifest is
`docs/volunteer-slack-app.manifest.yml`.

1. Create a Slack app in the community workspace. Slash commands (Request URL
   `https://<deployment>/api/slack-volunteers`): `/volunteer`,
   `/volunteer-exec`, `/volunteer-admin`.
   Turn on Interactivity with the same URL, and set the same URL as the
   **Options Load URL** (needed for the volunteer search boxes). Bot scopes: `commands`,
   `chat:write`, `im:write`, `files:write`, `users:read`. Install it.
2. Create a private approvals channel and invite the bot.
3. Set these environment variables:

```text
SLACK_VOLUNTEER_BOT_TOKEN
SLACK_VOLUNTEER_SIGNING_SECRET
SLACK_VOLUNTEER_APPROVALS_CHANNEL_ID
SLACK_VOLUNTEER_ADMIN_USER_IDS    comma-separated Slack IDs who can manage staff
SLACK_VOLUNTEER_LOG_CHANNEL_ID    (optional ops log)
SLACK_VOLUNTEER_APP_TOKEN         (local Socket Mode only)
VOLUNTEER_ORG_NAME                (optional, defaults to "UTSC MSA")
VOLUNTEER_LETTERHEAD_CONTACT      (optional contact line printed on letters)
VOLUNTEER_LETTERHEAD_LOGO_PATH    (optional PNG or JPG path; the MSA logo is built in)
```

4. Apply `migrations/004_create_volunteer_tables.sql` by hand with `psql`,
   then confirm with `\d`. It seeds the General / Jummah / Specific Event
   categories. It does not create a volunteer year.
5. Open `/volunteer-admin` as one of the `SLACK_VOLUNTEER_ADMIN_USER_IDS`
   users, add the staff (with their title) and create the current volunteer
   year. Slack user IDs are per workspace, so use the IDs from the community
   workspace. (Raw SQL also works:
   `INSERT INTO volunteer_staff (slack_user_id, display_name, title, can_approve, can_manage, is_primary) VALUES (...)`.)

Only one staff member can be `is_primary`; they are @mentioned on each card.

Local development uses Socket Mode with a dev Slack app, and **never touches
your real database**: `npm run dev:volunteers` refuses to start unless
`.env.volunteers` provides its own `DATABASE_URL` (a Neon test branch).
`npm run check:volunteers` checks the Slack tokens and the test database
without printing any secret. The full walkthrough, with a step-by-step test
script, is in [`docs/volunteer-testing.md`](docs/volunteer-testing.md).

#### Isolation from the live bot

The volunteer system is wired up in `src/volunteer-application.ts`, not
`src/application.ts`, and only `api/slack-volunteers.ts` and
`src/volunteer-index.ts` import it. The event and Jummah functions that serve
the live bot and website therefore never load volunteer code or the PDF
libraries, so they can't be slowed down or broken by it. A test
(`src/volunteer-isolation.test.ts`) fails if an import ever breaks that.

#### Tests

```bash
npm test
```

runs the unit tests: service rules (the in-memory repository), the Slack view
builders, and a check that every modal and message the bot builds stays inside
Slack's limits (title length, 100 options, 3000 characters per section,
duplicate block IDs, and so on) even with worst-case data.

The real SQL (the migration, constraints, the atomic edit and delete
statements, linking a volunteer to Slack, concurrent claims) is covered by an
integration test that is skipped unless you point it at a Postgres database:

```bash
VOLUNTEER_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres npm test
```

It creates a uniquely named schema, applies `migrations/004` into it, runs the
whole scenario, and drops the schema afterwards, so it touches nothing else in
that database. Still use a local or throwaway database, never production.

### Platform Adapters

External platforms should be isolated behind adapters.

Conceptually:

```text
PublishingService
       │
       ├── SlackAdapter
       ├── InstagramAdapter
       ├── GoogleCalendarAdapter
       └── WhatsAppAdapter
```

The rest of the application should not need to understand how each platform works internally.

### WhatsApp Gateway

WhatsApp requires a persistent linked-device connection, making it poorly suited to Vercel's serverless environment.

A separate Kotlin/Ktor service will therefore run on an always-on VM:

```text
Vercel Backend
      │
      │ HTTPS
      ▼
Kotlin / Ktor
      │
    Cobalt
      │
      ▼
  WhatsApp
```

The gateway should expose a small authenticated API such as:

```text
POST /send
POST /send-media
GET  /health
```

This keeps Cobalt and the unofficial WhatsApp integration isolated from the main application.

---

# Development Roadmap

## P0 — Core Content Platform

### Goal

Build the minimum end-to-end system:

```text
Slack
  ↓
Bolt
  ↓
TypeScript Backend
  ↓
Neon Postgres + Vercel Blob
  ↑
Website
```

At this stage, the backend only needs to store and manage content. External publishing will come later.

### Tasks

* [ ] Create the `msa-publisher` repository
* [ ] Initialize the TypeScript project
* [ ] Create and configure the Slack app
* [ ] Integrate Slack Bolt
* [x] Implement `/event`
* [ ] Implement `/meeting`
* [x] Implement `/jummah`
* [ ] Build Slack modals for each content type (`/event` and `/jummah` complete)
* [ ] Deploy Bolt/backend endpoints to Vercel
* [x] Create the initial Neon schema
* [x] Add Vercel Blob image storage
* [ ] Configure production environment variables and secrets
* [x] Implement backend validation for events
* [x] Implement the shared content service
* [x] Write submitted events to Neon and their images to Vercel Blob
* [x] Return success/error feedback to Slack events
* [x] Add a public read API for visible events
* [ ] Reconfigure the MSA website to retrieve content from the backend API
* [ ] Add basic application logging/error handling
* [x] Add basic event edit/delete functionality

### Keep in Mind

#### Use a generic content architecture

Do not create completely separate backend pipelines such as:

```text
createEvent()
→ saveEvent()
→ publishEvent()
→ editEvent()
→ deleteEvent()

createMeeting()
→ saveMeeting()
→ publishMeeting()
→ editMeeting()
→ deleteMeeting()

createJummah()
→ saveJummah()
→ publishJummah()
→ editJummah()
→ deleteJummah()
```

Instead, share as much infrastructure as practical:

```text
Slack Command
      ↓
Normalize Content
      ↓
ContentService
      ↓
Repository
```

Individual content types can still have specialized fields.

For example:

```text
Event
├── title
├── description
├── eventDate
├── startTime
└── endTime

Jummah
├── firstStartTime
├── firstEndTime
├── firstLocation
├── secondStartTime (optional)
├── secondEndTime (optional)
├── secondLocation (optional; defaults to firstLocation)
├── isOffered
└── unavailableMessage (used when Jummah is not offered)
```

The goal is to reuse common application logic without forcing genuinely different content into an awkward universal structure.

#### Keep Slack separate from business logic

Bolt should translate Slack interactions into application calls.

For example:

```text
/event modal submitted
        ↓
Bolt parses Slack payload
        ↓
ContentService.create(...)
```

The `ContentService` should not care whether the request originated from Slack. That way, if we ever decide to change the frontend interface (e.g. to an admin portal on the website), we don't need to refactor any code.

---

## P1 — Multi-Channel Publishing

### Goal

Allow MSA staff to create content once and publish it across supported platforms.

```text
                         ┌── Website
                         │
Slack → Backend → Content├── Slack
                         ├── Instagram
                         └── Google Calendar
```

### Tasks

* [x] Add Slack user authorization
* [x] Restrict commands/actions to approved users
* [ ] Add publishing destination selection to Slack modals
* [ ] Implement `SlackAdapter`
* [ ] Implement `InstagramAdapter`
* [ ] Integrate the Meta Instagram publishing API
* [x] Implement `GoogleCalendarAdapter`
* [x] Create Google Calendar events where applicable
* [x] Store external platform IDs
* [ ] Create lightweight publication logging
* [x] Return per-platform publishing results to Slack (Google Calendar only so far)
* [x] Handle partial publishing failures (Google Calendar only so far)
* [ ] Add configuration for channel/calendar/platform destinations

A Slack publishing form could eventually contain:

```text
Publish to:

☑ Slack
☑ Instagram
☑ Google Calendar
```

### Publication Tracking

Publishing should be tracked individually per destination.

For example:

```text
Website          ✓
Slack            ✓
Google Calendar  ✓
Instagram        ✗
```

A failed Instagram request should not undo a successfully created event.

A simple publication record could contain:

```text
content_id
platform
status
published_at
external_id
error_message
```

### External IDs

When an external platform creates something, save its identifier.

Examples:

```text
instagram_post_id
slack_message_id
google_calendar_event_id
```

This will allow future updates or cancellations to target the correct external resource.

---

## P2 — WhatsApp & Infrastructure

### Goal

Add WhatsApp publishing through a persistent Kotlin/Cobalt gateway and introduce lightweight database maintenance.

### Architecture

```text
TypeScript Backend
       │
       │ HTTPS
       ▼
    Free VM
       │
   Kotlin/Ktor
       │
     Cobalt
       │
       ▼
   WhatsApp
```

### Tasks

* [ ] Provision/configure the VM
* [ ] Create the Kotlin/Ktor WhatsApp gateway
* [ ] Integrate Cobalt
* [ ] Pair the MSA WhatsApp account
* [ ] Persist the linked-device session
* [ ] Implement `POST /send`
* [ ] Implement `POST /send-media`
* [ ] Implement `GET /health`
* [ ] Secure communication between Vercel and the VM
* [ ] Configure WhatsApp destination mappings
* [ ] Implement `WhatsAppAdapter` in the TypeScript backend
* [ ] Add WhatsApp results to publication logging
* [ ] Add basic Cobalt connection monitoring
* [ ] Configure the VM maintenance cron
* [ ] Run periodic database and media retention maintenance
* [ ] Delete stale content according to retention rules
* [ ] Delete associated stored media when appropriate

### WhatsApp Destination Mapping

The main backend should not need to know actual WhatsApp group IDs.

Instead:

```text
community-announcements → WhatsApp ID
brothers-chat           → WhatsApp ID
sisters-chat            → WhatsApp ID
jummah                   → WhatsApp ID
```

The TypeScript application can request:

```text
destination: "jummah"
```

and the WhatsApp gateway resolves the actual chat.

### Keep in Mind

Cobalt is an unofficial WhatsApp integration.

It should therefore remain isolated from the core system.

If WhatsApp/Cobalt stops working:

```text
Slack      ✓
Neon DB    ✓
Website    ✓
Instagram  ✓
Calendar   ✓
WhatsApp   ✗
```

The rest of MSA Publisher should continue functioning normally.

---

## P3 — Scheduling & Automation

### Goal

Allow MSA staff to schedule content for future publication.

For example:

```text
Create Event

Publish:
○ Now
● Schedule

Date: Thursday
Time: 6:00 PM
```

### Tasks

* [ ] Add scheduling controls to applicable Slack modals
* [ ] Add `publish_at`
* [ ] Add scheduling status
* [ ] Store scheduled publications in Neon
* [ ] Configure periodic cron execution
* [ ] Query Neon for due publications
* [ ] Reuse the existing publishing service
* [ ] Mark successful publications as published
* [ ] Track results individually per platform
* [ ] Prevent duplicate scheduled publications
* [ ] Retry appropriate transient failures
* [ ] Add recurring/templated Jummah workflows if useful
* [ ] Add update/cancel propagation where supported
* [ ] Consider draft → preview → publish workflow

### Scheduling Architecture

Keep scheduling simple.

```text
Neon Postgres

publish_at = 2026-09-10 18:00
status = scheduled

          ↓

Cron periodically runs

          ↓

Backend queries Neon

          ↓

Find due publications

          ↓

Existing PublishingService

    ┌─────┼─────┬─────┐
    ▼     ▼     ▼     ▼
 Slack  Insta  WA   Calendar
```

The scheduler should reuse the same publishing code used when someone presses **Publish Now**.

---

# Security

The system should follow several basic security rules from the beginning:

* Store credentials in environment variables.
* Never commit API keys or access tokens.
* Verify incoming Slack requests.
* Restrict publishing functionality to authorized Slack users.
* Authenticate Vercel → WhatsApp gateway requests.
* Use HTTPS for communication with the VM.
* Restrict unnecessary VM network access.
* Treat the Cobalt session as sensitive authentication material.
* Prefer a dedicated organizational WhatsApp account.
