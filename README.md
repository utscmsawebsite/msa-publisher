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
