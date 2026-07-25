# TrainerOS — notifications.md (v1)

Status: Draft for review
Scope: workout reminder emails only. One channel (email), one kind ('workout_reminder').
Persistence: `notification_schedules` and `notification_deliveries` tables — see database.md.

This is the deliberately-hard subsystem of v1. It exists to be correct, observable, and defensible — not to be big.

---

## Honest scale statement

At v1 scale (~3 clients, ≤3 reminders/day each), a Postgres table polled by a cron loop would be fully sufficient. This subsystem uses Azure Queue Storage anyway, for two stated reasons: (1) it is the author's hands-on lab for AZ-204 messaging content; (2) it forces engagement with real delivery semantics (at-least-once, visibility timeouts, poison messages) at a scale where mistakes are cheap. The DB remains the source of truth; the queue is only a delivery mechanism. If the queue disappeared tomorrow, no data would be lost — only timeliness.

Rejected: Azure Service Bus — sessions, topics, FIFO, and dead-letter forwarding are capabilities reminders don't need; Queue Storage's simpler model is the right-sized tool. Rejected: pure DB polling — sufficient, but teaches nothing new.

---

## Architecture

```
[Scheduler]  timer-triggered Azure Function, every 15 min
    │  computes upcoming occurrences from notification_schedules + users.timezone
    │  INSERT INTO notification_deliveries ... ON CONFLICT (idempotency_key) DO NOTHING
    │  for each newly-inserted row: enqueue { delivery_id } to Azure Queue Storage
    ▼
[Queue]  Azure Queue Storage 'reminders'
    │  at-least-once delivery, visibility timeout, dequeue count
    ▼
[Worker]  queue-triggered Azure Function
    │  load delivery row → guard on status → send email via provider → update row
    ▼
[Provider]  Resend (transactional email). Adapter interface so channel is swappable.
```

Two functions, one queue, one table. That is the whole system.

---

## Scheduler

Runs every 15 minutes. For each enabled schedule:

1. Compute the next occurrence(s) falling within the lookahead window (now → now + 30 min) by combining `send_time` + `days_of_week` with the **current** `users.timezone`.
2. Insert a `notification_deliveries` row with `idempotency_key = {schedule_id}:{occurrence date}` and `status = 'pending'`, using `ON CONFLICT DO NOTHING`.
3. For each row actually inserted (not conflicted), enqueue `{ delivery_id }`.

**Decisions:**
- **Idempotency lives in the database, not the scheduler.** The scheduler can run twice, crash mid-run, or be replayed; duplicate occurrences collapse into no-op inserts. Correctness does not depend on the timer firing exactly once. (Rejected: dedupe logic in scheduler memory — evaporates on restart.)
- **Timezone is resolved at schedule-computation time**, from `users.timezone`, per occurrence. A client who moves cities gets correct reminders after updating their profile, with no schedule migration.
- **DST rule:** `send_time` is local wall-clock time. "07:00" means 07:00 whatever UTC offset that is on that date. On the spring-forward day, a send_time inside the nonexistent hour (e.g. 02:30) resolves to the next valid instant. Wall-clock semantics match human expectation; UTC-fixed schedules drift an hour twice a year. (Rejected: storing UTC send times.)
- **Skip rule:** if `users.is_active = false` or the schedule was disabled after insertion, the worker (not the scheduler) makes the final call at send time — see guard below.

(Resolved in #36: (1) The idempotency_key's date component is the occurrence's **local** date, not the UTC date of the resulting instant — a Friday 23:30 Toronto reminder keys on Friday, though it fires Saturday UTC. 
(2) Fall-back ambiguity (a wall clock occurring twice, e.g. 01:30 on 2026-11-01 in Toronto) resolves to the **earlier** instant so the reminder isn't an hour late; one delivery row exists per occurrence date regardless. The spec covered spring-forward but was silent on fall-back. (3) "Next valid instant" for spring-forward gaps is read literally as the first instant that exists (02:30 → 03:00 local), not wall-clock-plus-gap-duration.)

(Resolved in #37: (1) An unresolvable users.timezone is skipped and logged at warning with a counter in the run summary — a batch over independent clients must not let one corrupt row starve everyone; the catch is narrow (TimeZoneNotFoundException only), DB failures still fail the run. (2) Enqueue failures are caught per-row, logged, counted, and stepped over: a missed insert is lost forever, a missed enqueue is recovered by the pending-sweep, so only the insert is worth aborting for. (3) Occurrences are converted with ToUniversalTime() before insert — Npgsql rejects non-zero offsets for timestamptz. (4) Queue messages are base64-encoded to match the Functions host's default queue-trigger decoding.)

## Queue

Azure Queue Storage, single queue `reminders`. Message body: `{ "delivery_id": "<uuid>" }` — nothing else.

**Decision: thin messages.** The row is the state; the message is a pointer. No payload drift between queue and DB, no stale email content, messages stay under limits trivially. (Rejected: full payload in message — two sources of truth.)

Local dev: Azurite emulator. The worker and scheduler run identically against it.

## Worker

Queue-triggered function. Per message:

1. Load `notification_deliveries` by id. If `status ∉ {pending, failed}` → ack and exit (idempotent consumption; a redelivered message for an already-sent row is a no-op).
2. Re-check `users.is_active` and `schedule.enabled`. If either is off → mark `status = 'dead'`, `last_error = 'skipped: disabled'`, ack. (Send-time guard: a client deactivated between scheduling and sending must not get email.)
3. Set `status = 'sending'`? **No — see delivery-semantics decision below.** Increment `attempts`, send via provider, then on success set `status = 'sent'`, `sent_at = now()`.
4. On provider error: set `status = 'failed'`, `last_error`, and throw — letting the queue's redelivery machinery own the retry.

**Delivery-semantics decision (the interview question in this doc):** this system is **at-least-once**. If the worker crashes after the provider accepts the email but before the row updates, the message redelivers and a duplicate email can be sent. The alternative — mark 'sent' before sending — is at-most-once: a crash loses the reminder silently. For reminders, a rare duplicate email is annoying; a silently lost one defeats the feature. Duplicate window is minimized (update immediately after provider ack) but not eliminated, and that is a stated tradeoff, not a bug. Exactly-once would require provider-side idempotency keys (Resend supports them — noted as a cheap v1.1 hardening: pass `idempotency_key` as the provider idempotency header, closing the duplicate window almost entirely).

(Resolved in #38: (1) Email names the active program, not a specific day — "Today: {program.Title} — {n} exercises" — because clients choose their training day by circumstance; predicting the next day in rotation would name the wrong one often enough to make the reminder misleading. (2) No active program at send time → dead with 'skipped: no active program'; an audit row beats a contentless email. (3) attempts is persisted with the outcome rather than before the send: a crash mid-send leaves it uncounted, which is the same window that makes this at-least-once, not a separate defect. (4) last_error is not cleared on a successful retry — the table is the audit log, and "sent on attempt 2 after a 429" is the more useful row. (5) An unknown delivery id acks rather than throws, so a message for a deleted row doesn't burn five dequeues reaching the poison queue. (6) Delivery timing: the scheduler enqueues within a 30-minute lookahead, so a queue message exists before its occurrence is due. Nothing in the worker's guards checks arrival — the invariant "a reminder is not sent before scheduled_for" is enforced at enqueue via visibility timeout (#39), not at consumption. Measured before that fix: −4m23s early.)

## Retry & dead-lettering

- Retries are delegated to Queue Storage: a thrown error makes the message reappear after the visibility timeout. Max dequeue count: 5.
- Backoff: visibility timeout set per-attempt by the worker before throwing — 1 min, 5 min, 15 min, 60 min (approximate exponential; provider outages are usually minutes-to-hours).
- On the 5th failure, the platform moves the message to `reminders-poison`. A lightweight poison-queue function marks the row `status = 'dead'` and logs at error level.
- A reminder that misses its moment is worthless: the worker also checks `scheduled_for` — if more than 6 hours stale, mark `dead` with `last_error = 'expired'` instead of sending a 2 a.m. "time to work out."

**Decision:** no custom retry framework. The platform's dequeue-count + visibility-timeout mechanics are the assignment; wrapping Polly around them would duplicate machinery. (Rejected: in-process retry loops — they hold the message invisible and turn a provider outage into a function timeout.)

## Failure modes (enumerated)

| Failure | Behavior | Covered by |
|---|---|---|
| Scheduler runs twice / replays | duplicate inserts collapse | idempotency_key unique index |
| Scheduler down for an hour | occurrences inside lookahead created late; >6h stale ones die | expiry check |
| Provider outage | retries with backoff, then poison → dead | queue mechanics |
| Worker crash mid-send | possible duplicate email | at-least-once, documented |
| Client deactivated after enqueue | not sent | worker send-time guard |
| Clock/DST transition | wall-clock semantics, nonexistent times roll forward | scheduler tz rules |
| Queue unavailable | scheduler inserts rows but enqueue fails → rows stay 'pending'; a sweep in the next scheduler run re-enqueues pending rows older than 20 min | pending-sweep |

The pending-sweep in the last row is also the recovery path if a message is ever simply lost: the DB is the source of truth, and 'pending' past its window means "re-enqueue me."

## Observability (v1-sized)

- `notification_deliveries` **is** the audit log — status, attempts, last_error, timestamps. First debugging tool is a SQL query, by design.
- Structured logs (delivery_id, schedule_id, attempt) from both functions → Application Insights (comes free with Functions; also AZ-204 content).
- No dashboards, no metrics pipeline in v1. One alert: poison-queue function logs at error severity.

## Email content

v1 template: plain, one per reminder. "Today: {program_day.title} — {n} exercises. Open TrainerOS →". Rendered at send time from current program data (thin messages mean content is never stale). Provider: Resend free tier; adapter interface `NotificationSender.send(delivery)` so WhatsApp/push later are new adapters + a `channel` value, not a redesign. (Revised in #16: INotificationSender takes a rendered EmailMessage, not a delivery row — the sender's contract serves auth; rendering from deliveries is the worker's job, #38.)

## Non-goals (v1)

- WhatsApp / SMS / web push (adapter slot exists; not built)
- Notification preferences UI beyond enable/disable + time
- Digest/batching, quiet hours, per-exercise nudges
- Exactly-once delivery (documented tradeoff instead)
- Metrics dashboards

## Resolved questions

1. **Trainer digest ("who logged yesterday") — deferred to v1.1, by rule.** The pipeline supports it cheaply (`kind = 'trainer_digest'`, one schedule row, one query over yesterday's workout_sessions, one template), which is precisely why deferral costs nothing. Rule adopted: no second notification kind ships before the first has delivered real email to a real client. Digest is v1.1 item #1 and serves as the test that the `kind` abstraction generalizes.
2. **Pause link — in v1, as pause (not unsubscribe machinery).** Footer link in every reminder → confirmation page → explicit button → POST sets `notification_schedules.enabled = false`. Trainer can re-enable from the dashboard.
   **Decision — why two steps instead of one-click:** email security scanners and link-prefetchers issue GET requests to footer links before the recipient opens the email. A one-click GET that mutates state would silently pause reminders for any client behind a scanning mail provider. Therefore: GET renders a confirmation page only; state changes happen on POST with a signed, single-purpose token (HMAC of schedule_id + expiry) in the URL. GET never mutates. (Rejected: one-click pause — broken by prefetch. Rejected: full preference center — v1 has one schedule per client; a toggle is the whole preference model.)
