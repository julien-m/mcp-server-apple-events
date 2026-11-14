# Apple Events MCP Server ![Version 1.6.2](https://img.shields.io/badge/version-1.6.2-blue) ![License: MIT](https://img.shields.io/badge/license-MIT-green)

[![X Follow](https://img.shields.io/twitter/follow/FradSer?style=social)](https://x.com/FradSer)

English | [简体中文](README.zh-CN.md)

A Model Context Protocol (MCP) server providing native integration with Apple Reminders and Calendar on macOS via the EventKit framework. Exposes reminders, lists, subtasks, and calendar events through a standardized interface with full CRUD operations.

The EventKit backend is the standalone [`event`](https://github.com/FradSer/event) Swift CLI, vendored as a git submodule and built into `bin/event` during `pnpm install` — no separate `brew install` required. See [docs/migration-to-event-cli.md](docs/migration-to-event-cli.md) for the v1.5.0 backend swap and the list of write fields not yet exposed by `event`.

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [macOS Permissions](#macos-permissions)
- [Usage Examples](#usage-examples)
- [Write confirmation and untrusted data](#write-confirmation-and-untrusted-data)
- [Available MCP Tools](#available-mcp-tools)
- [Structured Prompt Library](#structured-prompt-library)
- [Development](#development)
- [License](#license)
- [Contributing](#contributing)

## Features

- Full CRUD for reminders, subtasks, reminder lists, and calendar events
- Priority (high/medium/low/none), tags, and checklist subtasks with progress tracking
- Multi-criteria filtering: completion, due-date range, priority, tags, full-text search, recurring, location-based
- Flexible date formats (`YYYY-MM-DD`, `YYYY-MM-DD HH:mm:ss`, ISO 8601) with timezone awareness
- Native macOS integration via EventKit — values configured in Reminders.app / Calendar.app round-trip through read responses
- Automatic macOS permission discovery and prompting
- Full Unicode support with comprehensive input validation

## Prerequisites

- **Node.js 20 or later**
- **macOS** (required for EventKit)
- **Xcode Command Line Tools** (only when building from source)
- **pnpm** (recommended)

The published npm package ships a pre-built, universal, code-signed `bin/event` binary, so `npx` users need neither Xcode nor a Swift toolchain. Building from a git clone requires the items above.

## Quick Start

```bash
npx mcp-server-apple-events
```

## Configuration

Add the server to your MCP client. The `npx` form works for every client below; for a local build, replace `command`/`args` with `node` pointing at `dist/index.js`.

### Cursor

Settings → MCP → Add new global MCP server:

```json
{
  "mcpServers": {
    "apple-reminders": {
      "command": "npx",
      "args": ["-y", "mcp-server-apple-events"]
    }
  }
}
```

### ChatWise

Settings → Tools → "+", then:

- Type: `stdio`
- ID: `apple-reminders`
- Command: `mcp-server-apple-events`
- Args: (empty)

### Claude Desktop

Edit `claude_desktop_config.json` (open it via Settings → Developer Option → Edit Config, or directly at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS / `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "apple-reminders": {
      "command": "npx",
      "args": ["-y", "mcp-server-apple-events"]
    }
  }
}
```

For a local build:

```json
{
  "mcpServers": {
    "apple-reminders": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-apple-events/dist/index.js"]
    }
  }
}
```

See the [official MCP docs](https://modelcontextprotocol.io/docs/develop/connect-local-servers) for connecting local servers. Restart Claude Desktop completely (quit, not just close) for changes to take effect.

## macOS Permissions

The server launches the vendored `event` CLI directly. macOS retains its normal attribution to the application that launched the server, so authorize that host under `System Settings > Privacy & Security > Reminders / Calendars`. Each host needs its own approval; a grant made from a terminal does not authorize a separate desktop MCP client.

The host must support EventKit permission requests and declare the required usage descriptions. If it does not, macOS may deny access without showing a prompt. Use a host that supports these permissions. The server does not bypass this restriction by making a public helper self-responsible: doing so would let unrelated local processes reuse that helper's Calendar and Reminders grant.

When `event` detects a `notDetermined` status it calls `requestFullAccessToReminders` / `requestFullAccessToEvents`. Run `./check-permissions.sh` from the same host context to diagnose access; running it in a terminal checks that terminal's permissions only. Usage descriptions are required for protected resources; see [Apple's app distribution guidance](https://help.apple.com/xcode/mac/current/en.lproj/dev91fe7130a.html).

### Calendar read errors or missing prompts

For `Failed to read calendar events`, enable **Full Calendar Access** for the calling application under `System Settings > Privacy & Security > Calendars`. If no prompt appears, check that the host supports EventKit permissions and declares the usage descriptions, then restart it and retry. AppleScript Automation approval is separate from EventKit Calendar and Reminders approval.

### Upgrading from the responsibility-disclaim helper

Reinstall the package to remove the old `bin/event-disclaim` artifact. For a source checkout, remove that generated file before rebuilding. Revoke the old `event` grant in `System Settings > Privacy & Security > Reminders / Calendars`, then authorize each host you intend to use. Updating the server cannot revoke existing macOS grants or remove older copies installed elsewhere.

### Headless / launchd runs hang instead of failing

When the server runs from a context with no GUI session (SSH, launchd agent/daemon), the first EventKit call can block forever waiting on a permission prompt that can never be rendered — the MCP request never settles and a child process leaks per call. The server now kills any `event` call that exceeds 30 s (`SIGKILL`) and returns a readable error instead. Tune it with the `EVENTKIT_CLI_TIMEOUT_MS` environment variable (milliseconds; invalid/zero values fall back to the default — the timeout cannot be disabled, though huge values up to `2^31-1` ms are accepted). The vendored `event` CLI (pinned via [FradSer/event#15](https://github.com/FradSer/event/pull/15)) additionally fails fast when no GUI session exists and gives up on an unanswerable prompt after 15 s (`EVENT_PERMISSION_TIMEOUT_MS`), reporting `Permission denied: Timed out waiting for ...` so the host can show a permission-specific message before the server's kill fires (15 s < 30 s). See [issue #113](https://github.com/FradSer/mcp-server-apple-events/issues/113).

### macOS 26 (Tahoe) `could not build module 'Foundation'`

If `pnpm build` fails with `could not build module 'Foundation'` (or `SDK is not supported by the compiler`), your Swift toolchain is older than the macOS 26 SDK requires — it needs **Swift 6.3 or newer**, but the Command Line Tools shipped with early macOS 26 point releases include Swift 6.2.x. `pnpm build:event` detects this and prints the same remediation; see [issue #85](https://github.com/FradSer/mcp-server-apple-events/issues/85). Fix by installing Xcode 26.x from the App Store, or updating Command Line Tools to a Swift 6.3+ version:

```bash
softwareupdate --list
sudo softwareupdate -i "Command Line Tools for Xcode-<latest>"
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer   # if full Xcode is installed
xcrun swiftc --version    # should report Apple Swift version 6.3 or newer
```

## Usage Examples

Once configured, ask Claude to interact with your Apple Reminders and Calendar. Example prompts:

```text
Create a reminder to "Buy groceries" for tomorrow at 5 PM with tags shopping and errands.
Add a high-priority reminder to "Finish quarterly report" due Friday in my "Work" list.
Create "Grocery shopping" with subtasks: milk, eggs, bread, butter.
Show me all high-priority reminders due today tagged "urgent".
Show subtasks for my "Grocery shopping" reminder and mark "milk" as complete.
Update "Buy groceries" — change the title to "Buy organic groceries" and set priority to high.
Show reminders from my "Work" list, and list all my reminder lists.
Create a calendar event "Team standup" tomorrow from 9:00 to 9:30 in "Work".
Show my calendar events for the next week.
Invite alex@example.com to my "Team standup" event.
Cancel just the September 21 occurrence of my weekly "Team standup".
```

The server processes natural-language requests, interacts with Apple's native Reminders and Calendar apps, and returns structured results.

> Reminder recurrence and early alerts are writable through `recurrence` and `earlyReminderMinutes`. Omit either field to preserve its value; pass `null` to remove it. Native Urgent is writable through `urgent`; location triggers remain read-only. Calendar recurrence remains read-only.

### Reminder recurrence and early alerts

Create or update a reminder with `recurrence: { frequency: "weekly", interval: 2 }` and `earlyReminderMinutes: 30`. Supported frequencies are `daily`, `weekly`, `monthly`, and `yearly`; the interval defaults to 1. An optional `endDate` ends the recurrence inclusively. Recurrence requires a due date; an early alert requires a due date with a time. On update, the existing due date can be used. Dates without an offset use the Mac's local time zone.

Updating another field preserves scheduling. The native Early Reminder field is written through an isolated, version-dependent ReminderKit adapter; EventKit alarms are preserved. `earlyReminderMinutes: null` clears the native Early Reminder. Setting or removing recurrence does not change other reminder fields. Set `urgent: true` to enable the native Urgent alarm, `urgent: false` to disable it, or omit it to preserve the current value. Enabling requires a due date with a time. The native Urgent setting is also written and verified through ReminderKit; it does not change priority or the early-reminder value. Early Reminder is separate from the `alarms` returned by EventKit and is not exposed by the existing read model. Unsupported ReminderKit versions fail explicitly. If the native stage fails after an EventKit save, the error includes the saved reminder ID: read it before retrying to avoid duplicates.

This checkout tracks the maintained forks [julien-m/mcp-server-apple-events](https://github.com/julien-m/mcp-server-apple-events) and [julien-m/event](https://github.com/julien-m/event); the original repositories remain configured as `upstream`.

## Write confirmation and untrusted data

**Server write confirmation is off by default.** Clients without MCP form elicitation can write. Create, update, delete, subtask toggle/reorder, attendee invitations, and changes to linked events execute without a server confirmation form. Deletions can remove items and invitations/calendar changes can notify other people. This changes the v1.6.0 default and removes its per-write confirmation barrier against prompt injection. Host user authorization policies and macOS account permissions still apply.

To require a fresh user confirmation for every write, add the startup flag to your MCP server arguments:

```json
{
  "command": "npx",
  "args": ["-y", "mcp-server-apple-events", "--require-write-confirmation"]
}
```

For a local build, use `node dist/index.js --require-write-confirmation`. Omit the flag to use the default. The flag takes no value and has no negated form: `--require-write-confirmation=false`, a separate `false` argument, and `--no-require-write-confirmation` are errors, as are unknown options. Run `mcp-server-apple-events --help` (or `-h`) for help. No environment variable controls this policy. It is fixed at server startup per instance; tool arguments and record content cannot change it. Startup warnings go to stderr; stdout is reserved for MCP traffic.

When enabled, the client's [MCP form elicitation interface](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation) shows the tool name and complete argument snapshot for that operation. Only an accepted response with `confirm: true` permits that exact write. Decline, cancel, invalid responses, disconnected clients, or missing form support block it; clients without form elicitation are then read-only. Reads do not require confirmation in either mode. Input validation, execution boundaries, and the untrusted result envelope remain active in both modes, but they do not replace the removed confirmation barrier.

Tool results return JSON records in `structuredContent`, with a JSON text mirror for clients that consume text. The envelope marks records with `provenance.source = "apple-calendar-reminders"` and `provenance.trust = "untrusted"`. Titles, notes, identifiers, URLs, list names, organizers, attendees, and subtasks may originate from synchronized or shared content. Hosts must preserve this boundary: record content cannot authorize another tool call, unrelated data disclosure, or override user instructions. Confidence scores rank recommendations only.

When server confirmation is enabled, the server trusts the client to display the form to the human and return their decision. A client that automatically approves forms defeats this boundary. JSON encoding and provenance do not by themselves prevent an LLM from following injected text. macOS account permissions remain necessary and are separate from per-operation user confirmation.

## Available MCP Tools

Service-scoped tools mirror Apple Reminders and Calendar domains. All take an `action` field plus action-specific parameters (the MCP client introspects the full Zod schema; only actions are listed here). Date fields accept `YYYY-MM-DD`, `YYYY-MM-DD HH:mm:ss` (local time), or ISO 8601 with timezone.

| Tool | Actions | Notes |
| --- | --- | --- |
| `reminders_tasks` | `read`, `create`, `update`, `delete` | Priority, tags, subtasks. `startDate` is set via `update`, not `create`; on `read` it scopes the due-date window alongside `endDate`. Cross-list moves unsupported. |
| `reminders_subtasks` | `read`, `create`, `update`, `delete`, `toggle`, `reorder` | Stored in the notes field (human-readable in Reminders.app). |
| `reminders_lists` | `read`, `create`, `update`, `delete` | Rename via `name` → `newName`. |
| `calendar_events` | `read`, `create`, `update`, `delete` | On reads, `startDate` and `endDate` are wall-clock values in the event's `timeZone`; timed events also include `startDateISO` and `endDateISO` as unambiguous UTC timestamps when available. Use the ISO fields to schedule or compare events. All-day events do not include them. All-day is inferred from date format. Cross-calendar moves remain unsupported. `span` scopes recurring deletes. `attendees` (update) invites addresses; `occurrenceDate` (delete) excepts one occurrence of a series — both need extra setup, see [Attendees and single occurrences](#attendees-and-single-occurrences). |
| `calendar_calendars` | `read` | Without a date range, every calendar EventKit reports, with its `source` and write permission. With `startDate`/`endDate`, calendars holding ≥1 event in the window, annotated with an event count. |

Example calls:

```json
{
  "action": "create",
  "title": "Buy groceries",
  "dueDate": "2024-03-25 18:00:00",
  "targetList": "Shopping",
  "note": "Don't forget milk and eggs",
  "priority": 1,
  "tags": ["shopping", "errands"],
  "subtasks": ["Milk", "Eggs", "Bread"]
}
```

```json
{ "action": "read", "filterList": "Work", "dueWithin": "today", "filterPriority": "high", "filterTags": ["urgent"] }
```

```json
{ "action": "read", "startDate": "2026-08-01", "endDate": "2026-08-31" }
```

```json
{ "action": "update", "id": "reminder-123", "completed": false, "addTags": ["followup"] }
```

```json
{ "action": "toggle", "reminderId": "reminder-123", "subtaskId": "a1b2c3d4" }
```

```json
{ "action": "create", "name": "Project Alpha" }
```

```json
{ "action": "create", "title": "Team standup", "startDate": "2026-05-04 09:00:00", "endDate": "2026-05-04 09:30:00", "targetCalendar": "Work" }
```

```json
{ "action": "update", "id": "event-123", "attendees": ["alex@example.com", "sam@example.com"] }
```

```json
{ "action": "delete", "id": "event-123", "occurrenceDate": "2026-09-21T09:00:00" }
```

### Attendees and single occurrences

These two `calendar_events` parameters are the only writes that do not go through the `event` CLI, because EventKit cannot express either one. Each needs setup the rest of the server does not.

**`attendees` (update)** — invites email addresses to an existing event. `EKCalendarItem.attendees` is read-only in the macOS SDK and EventKit has no invitation API, so the write goes through Calendar.app's scripting interface; adding the attendee locally is what makes iCloud send the invitation.

- Requires an **Automation** grant: the first call prompts, and the entry appears under `System Settings > Privacy & Security > Automation`. Needs a GUI session, so it does not work headless.
- Attendees must be updated **alone**. They travel through Calendar.app while every other field travels through EventKit, and the two share no concurrency token — a combined update has no safe ordering, so it is refused. Issue two calls.
- Two events sharing a title and a start date are **refused, not guessed between**. Calendar.app can only be queried by title and date, and writing to the wrong one would send a real invitation for it.

**`occurrenceDate` (delete)** — excepts one occurrence of a recurring series. Every occurrence shares one EventKit identifier, so `span: "this-event"` can only ever except the series start; aimed at a later occurrence it writes nothing and still reports success. Supplying `occurrenceDate` routes the delete over CalDAV, which can address the instance directly.

- Requires iCloud credentials. Set `ICLOUD_APPLE_ID` and `ICLOUD_APP_PASSWORD`, or set `ICLOUD_APPLE_ID` and store the password in the Keychain:

  ```bash
  security add-generic-password -a "you@icloud.com" -s "icloud-caldav-mcp" -w
  ```

  Use an [app-specific password](https://support.apple.com/en-us/102654), never your account password. Credentials are read from the environment first, then the Keychain, never from MCP client config, and are never logged.
- Only iCloud-synced events qualify — an event with no external identifier has no CalDAV resource to locate.
- CalDAV requests have a 30-second deadline across redirects and response reads, and a 2 MiB response limit. Calendar editing also limits resources to 20000 physical/content lines, 64 KiB per unfolded UTF-8 line, 16 nested components, 2000 events, and 1000 recurrence IDs. Oversized or overly complex resources fail with an actionable error before a calendar write; serialized output must fit the same size and line-count limits.

### Read response shape

Read tools return a `structuredContent` envelope whose `records` array contains the domain objects returned by that tool. Native values are preserved, including numeric reminder priorities (`0`, `1`, `5`, or `9`) rather than presentation labels. For example:

```json
{
  "provenance": {
    "source": "apple-calendar-reminders",
    "trust": "untrusted"
  },
  "records": [
    {
      "id": "reminder-123",
      "title": "Buy groceries",
      "isCompleted": false,
      "list": "Shopping",
      "notes": "Don't forget milk and eggs",
      "url": "https://example.com",
      "dueDate": "2024-03-25T18:00:00Z",
      "priority": 1,
      "tags": ["shopping", "errands"],
      "subtasks": [
        { "id": "a1b2c3d4", "title": "Milk", "isCompleted": true },
        { "id": "e5f6a7b8", "title": "Eggs", "isCompleted": false },
        { "id": "c9d0e1f2", "title": "Bread", "isCompleted": false }
      ],
      "subtaskProgress": { "completed": 1, "total": 3, "percentage": 33 }
    }
  ]
}
```

The accompanying `content` array contains a static text summary first (for example, `Read reminders.`), followed by a text item containing the serialized JSON mirror of the same `structuredContent` object. Clients that consume text can parse the second item; clients that support structured results should use `structuredContent`.

Reminder URLs are stored in the native `url` property and in the structured `URLs:` notes block. Calendar event URLs are stored in EventKit's native URL property. Both reject unsafe URI schemes and blocked HTTP(S) addresses.

> **Read-only fields**: arbitrary reminder alarms and location triggers, calendar recurrence rules and structured locations, all-day toggles, and cross-calendar moves are not writable via this server. Calendar event alarms, URLs, and scheduling availability can be set through create/update. Calendar availability writes require a calendar that supports the selected value. See [docs/migration-to-event-cli.md](docs/migration-to-event-cli.md) for the remaining gaps.

## Structured Prompt Library

The server ships a prompt registry exposed via the MCP `ListPrompts` / `GetPrompt` endpoints. Each template shares a mission, context inputs, numbered process, constraints, output format, and quality bar so downstream assistants get predictable scaffolding.

- **daily-task-organizer** — optional `today_focus`; produces a same-day execution blueprint, balances priority work with recovery, auto-creates calendar time blocks for due-today reminders.
- **smart-reminder-creator** — optional `task_idea`; generates an optimally scheduled reminder structure.
- **reminder-review-assistant** — optional `review_focus` (e.g. `overdue` or a list name); audits and optimizes existing reminders.
- **weekly-planning-workflow** — optional `user_ideas`; guides a Monday-through-Sunday reset with time blocks tied to existing lists.

Prompts are constrained to native Apple Reminders capabilities and ask for missing context before irreversible actions. Run `pnpm test -- src/server/prompts.test.ts` after amending prompt copy.

## Development

```bash
pnpm install        # postinstall builds bin/event from vendor/event on macOS
pnpm build          # TypeScript + vendored event CLI
pnpm test           # Jest suite: repositories, schemas, build script, prompt templates
pnpm exec biome check   # lint + format
```

The CLI entry point walks up to ten directories to find `package.json`, so the server can start from nested paths (e.g. `dist/` or editor task runners) without losing `bin/event`. Keep the manifest reachable within that depth if you customize the folder layout.

### Scripts

- `pnpm build` — TypeScript + vendored `event` CLI (required before running from source)
- `pnpm build:ts` — TypeScript only
- `pnpm build:event` — vendored `event` CLI only (`swift build -c release` → `bin/event`)
- `pnpm build:release` — build plus notarization (release packaging)
- `pnpm test` / `pnpm test:ci` — Jest suite / with coverage
- `pnpm lint` — Biome format/fix + TypeScript type check
- `pnpm check` — lint + tests with coverage

## License

MIT

## Contributing

Contributions welcome! Please read the contributing guidelines first.

## Reminder write concurrency

Reminder reads (`reminders_tasks`, and the parent record from `reminders_subtasks`)
return a `version`: a SHA-256 token for the complete native observation. Pass that
exact token as `expectedVersion` for task update/delete and **every subtask write**,
including subtask creation. Read again after a successful write. Missing versions
return `revision_required`; stale versions return `revision_conflict`, without
starting a native mutation. Clients must upgrade to this contract.

The MCP owns the complete read/modify/write/readback critical section. All reminder
and reminder-list writes from cooperating MCP processes under the same macOS user
share one filesystem lock, including writes from separate stdio/HTTP sessions.
Atlas and other clients should consume this contract rather than implement their
own reminder lock. List writes share serialization but do not expose snapshot
preconditions. Existing action approval requirements remain applicable.

Results expose `structuredContent.concurrency.guarantee = native_observed_non_atomic`.
The repository checks the native acknowledgement against the exact sent fields
(including composed notes); the coordinator then compares it with a fresh native
read. A matching acknowledgement/readback alone does not prove the requested effect. Subtask writes also return `reminderWrite.id/version` for their parent.
Delete success requires the exact native not-found readback. A detected discrepancy
returns `needs_reconciliation`; a failed/ambiguous write or readback returns
`outcome_unknown`, retaining any available native identity. Neither case is retried
automatically. Reconcile by reading before deciding on another write; do not replay
an uncertain create. This is not durable request-id deduplication.

The lock protects **cooperating local MCP writers**, not direct `bin/event` calls,
Reminders.app, Atlas's own EventKit adapter, or changes arriving from iOS/iCloud.
Apple EventKit has no conditional reminder save/delete tied to this snapshot.
External edits can occur between checks and may be overwritten or remain
undetectable. A matched readback proves only the observed Mac store state, not
atomic cross-device isolation, iCloud propagation, or notification delivery.
Atlas must keep its local revisions, approvals, identity mappings and reconciliation
of unknown/conflicting outcomes.

Lock acquisition waits at most 10 seconds, then returns `writer_busy` without
starting a write. Cancellation before execution prevents the queued mutation.
The lock is released on normal completion/errors. A crashed writer leaves a lock
at `~/Library/Application Support/mcp-server-apple-events/reminder-write.lock`.
It is deliberately never stolen on a timer: first stop all cooperating writers
and their native helpers, reconcile any uncertain reminder operation, and only
then remove the orphan directory. The lock stores no reminder contents.

Urgent and Early Reminder writes remain available, but their ReminderKit values
are absent from the native read model. Such writes retain their native identity
and return `outcome_unknown` instead of claiming verified success. Do not repeat
them blindly. The native read model must expose those fields before this MCP can
verify their final values.

### Targeted absolute temporal alarm

`reminders_tasks` accepts `temporalAlarm` on create/update:

- `{ "action": "add", "at": "<instant>" }` adds one absolute display alarm.
- `{ "action": "replace", "target": "<observed absoluteDate>", "at": "<instant>" }`
  replaces exactly one non-location absolute alarm with a new absolute display alarm.
- `{ "action": "clear", "target": "<observed absoluteDate>" }` removes that alarm.

Create accepts `add` only. Omission preserves all alarms. Update still requires
`expectedVersion` from the last read. The action is the alarm field mask: it never
clears all alarms, changes a relative/location alarm, or selects an array index.
The selector is the observed instant, not an invented native alarm ID; equivalent
offsets identify the same instant. Zero matches return `temporal_alarm_target_missing`;
multiple matches return `temporal_alarm_target_ambiguous`. A new alarm colliding
with another absolute temporal alarm returns `temporal_alarm_duplicate`.

Instants must be strict RFC3339 with an explicit `Z` or `±HH:mm` offset, whole
seconds (optional `.000` is accepted for native readback), in UTC years 2001–2099.
Offsets are limited to ±14:00; `-00:00`, nonzero fractional seconds, leap seconds,
invalid calendar dates and implicit local-zone values are rejected. No DST or
locale correction is performed. A new `at` must be strictly later than the captured
validation clock, checked again natively before save. A past `target` may be
cleared. The offset defines the instant; a named display zone is not inferred. Timed dueDate/startDate values supplied alongside temporalAlarm must also carry an explicit offset and have seconds00: native Reminders persists those fields only to the minute, while absolute alarms retain seconds. Nonzero due/start seconds are rejected rather than rounded. If intentionally moving both due and start, supply both fields explicitly; unspecified fields remain preservation-checked.

The native boundary adds/removes only the selected `EKAlarm`, preserving other
alarms and reminder fields. The repository checks the complete preserved alarm
multiset and native fields outside explicitly supplied mutation fields, then the
coordinator performs its fresh readback. A late baseline version change is refused
before invoking the write. Known pre-save rejections carry `error.outcome=not_started`;
a failed post-save step preserves `nativeReceipt.id` when available and remains
`outcome_unknown`. The JSON text mirror includes the same receipt as structured
content. Never replay an uncertain create; reconcile its retained identity first.
The existing `native_observed_non_atomic` limit still applies.

A readback containing a temporal alarm proves its observed native-store state.
It does not prove OS notification permission, delivery, iCloud propagation or
notification receipt after an application quits. Those require a separately
observed synthetic qualification. Urgent/Early Reminder limitations remain as
specified above.

Read [the qualification script](examples/temporal-alarm-qualification.mjs) and
[its strict input boundary](examples/temporal-alarm-config.mjs) for one explicitly
authorized synthetic run. Supply a reviewed JSON config with `url`, `clientName`,
`statePath`, `receiptPath`, `timeoutMs`, `minimumLeadMs`, unique `listName`,
`reminder` (`title`, optional `note`/`dueDate`, `temporalAlarm` add), and 2–8
`writers` (`title`, future `at`). Run phases `prepare`, `contend`, `read`, then
`cleanup`, passing that config path. Each writer is a separate real MCP client
process using the same captured version; no lock is implemented in the script.
The script refuses existing creation attempts, logs only its own synthetic records
and list aggregates, and never deletes a reminder/list. Cleanup rereads the owned
identity/version, clears only the observed test alarm and marks the fixture
completed, retaining its baseline and record/list for review. Native notification
observation and the safe application-shutdown window are recorded separately.
