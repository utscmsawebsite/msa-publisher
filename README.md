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

The Vercel deployment exposes two independent serverless functions from the
same project:

```text
POST /api/slack   Slack commands and interactive payloads
GET  /api/events  Public events currently visible on the website
```

`GET /api/events` returns events whose optional Toronto publication time has
arrived and whose event date is today or later. Internal Slack user IDs and
publishing metadata are not included in the public response.

Local development continues to use Socket Mode:

```bash
npm run dev
```

Production uses Slack's signed HTTP requests. Configure these environment
variables in Vercel:

```text
SLACK_BOT_TOKEN
SLACK_SIGNING_SECRET
DATABASE_URL
BLOB_READ_WRITE_TOKEN
```

`SLACK_APP_TOKEN` is only required for local Socket Mode. After deploying, use
the production `/api/slack` URL for both the `/event` command Request URL and
the Interactivity Request URL, then disable Socket Mode.

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
* [ ] Implement `/jummah`
* [ ] Build Slack modals for each content type (`/event` complete)
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
* [ ] Add basic edit/delete functionality

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
├── publishDate (optional)
├── publishTime (optional)
└── eventDate

Jummah
├── date
├── location
├── salah1
├── salah2
└── khateeb
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

* [ ] Add Slack user authorization
* [ ] Restrict commands/actions to approved users
* [ ] Add publishing destination selection to Slack modals
* [ ] Implement `SlackAdapter`
* [ ] Implement `InstagramAdapter`
* [ ] Integrate the Meta Instagram publishing API
* [ ] Implement `GoogleCalendarAdapter`
* [ ] Create Google Calendar events where applicable
* [ ] Store external platform IDs
* [ ] Create lightweight publication logging
* [ ] Return per-platform publishing results to Slack
* [ ] Handle partial publishing failures
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
