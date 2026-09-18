# Product Engineering Challenge Submission

## Candidate

- **Name:** Kushagra Srivastava
- **Email:** _(add your email)_
- **GitHub:** _(add your GitHub profile or repo URL)_
- **Selected problem:** Problem 2 — Webhook Retry Engine
- **Demo video:** https://drive.google.com/file/d/1N4R_I1bbeDpGVcFYf6U7vWuKsJVbBGS4/view?usp=sharing

## Run the project

**Prerequisites:** Node.js 20+, npm

**Environment variables** (names only; no secrets committed):

| Name | Default | Purpose |
| --- | --- | --- |
| `WEBHOOK_URL` | `http://127.0.0.1:8090/webhook` | Outbound delivery target |
| `HTTP_ADDR` | `8080` | API listen port |
| `DATABASE_PATH` | `webhook.db` | SQLite file path |
| `MAX_ATTEMPTS` | `5` | Attempt budget |
| `BASE_DELAY_MS` | `1000` | Backoff base (`delay = base * 2^(n-1)`) |
| `DELIVERY_TIMEOUT_MS` | `5000` | Outbound HTTP timeout |
| `POLL_INTERVAL_MS` | `200` | Worker poll interval |
| `FAKE_RECEIVER_PORT` | `8090` | Demo receiver port |

```text
npm install

# Terminal 1 — local webhook receiver
npm run fakereceiver

# Terminal 2 — engine
WEBHOOK_URL=http://127.0.0.1:8090/webhook npm start
```

**Successful scenario (AC1):**

```text
# ensure receiver succeeds
curl -s -X POST http://127.0.0.1:8090/mode -H 'content-type: application/json' -d '{"mode":"ok"}'

curl -s -X POST http://127.0.0.1:8080/events -H 'content-type: application/json' -d '{
  "eventId": "evt_ok_1",
  "type": "incident.created",
  "occurredAt": "2026-09-15T10:00:00Z",
  "payload": { "incidentId": "inc_456", "severity": "high" }
}'

# wait ~1s
curl -s http://127.0.0.1:8080/events/evt_ok_1
```

Expect `status: "delivered"`, `attemptCount: 1`, one attempt with `outcome: "success"`.

**Failure / recovery scenario (AC2):**

```text
curl -s -X POST http://127.0.0.1:8090/mode -H 'content-type: application/json' -d '{"mode":"fail"}'

curl -s -X POST http://127.0.0.1:8080/events -H 'content-type: application/json' -d '{
  "eventId": "evt_retry_1",
  "type": "incident.created",
  "occurredAt": "2026-09-15T10:00:00Z",
  "payload": { "incidentId": "inc_789", "severity": "medium" }
}'

# inspect quickly — expect pending + retryable 503
curl -s http://127.0.0.1:8080/events/evt_retry_1

# restore receiver, wait for backoff (~2s with default BASE_DELAY_MS=1000)
curl -s -X POST http://127.0.0.1:8090/mode -H 'content-type: application/json' -d '{"mode":"ok"}'
sleep 2
curl -s http://127.0.0.1:8080/events/evt_retry_1
```

Expect final `status: "delivered"` with two attempts (`retryable` then `success`).

## Run the tests

```text
npm test
```

Uses an in-process fake HTTP server and `Worker.runOnce()` with `BASE_DELAY_MS=0` — no paid services, no arbitrary sleep timing.

## Acceptance scenarios and verification

| Scenario | Status | How verified |
| --- | --- | --- |
| AC1 Successful delivery | Complete | Manual curl/Postman + automated test `delivered on success` |
| AC2 Temporary failure and retry | Complete | Manual mode fail→ok + test `retry then delivered` |
| AC3 Bounded failure | Complete | Leave mode fail until max attempts + test `failed after max attempts` |
| AC4 Idempotent ingestion | Complete | Duplicate POST → 201 then 200 + test `idempotent ingest` |
| AC5 Inspectable history | Complete | `GET /events/:eventId` returns status + ordered attempts |

No intentional reinterpretation of the brief. Delivery is **at-least-once** across the HTTP boundary (documented below).

**Problem-specific verification (manual benchmark steps):**

```text
# 1) Success
curl -s -X POST http://127.0.0.1:8090/mode -H 'content-type: application/json' -d '{"mode":"ok"}'
curl -s -o /tmp/ac1.json -w '%{http_code}\n' -X POST http://127.0.0.1:8080/events -H 'content-type: application/json' -d '{"eventId":"bench_ok","type":"incident.created","occurredAt":"2026-09-15T10:00:00Z","payload":{"x":1}}'
sleep 1
curl -s http://127.0.0.1:8080/events/bench_ok

# 2) Idempotent re-ingest
curl -s -o /dev/null -w 'first:%{http_code}\n' -X POST http://127.0.0.1:8080/events -H 'content-type: application/json' -d '{"eventId":"bench_dup","type":"incident.created","occurredAt":"2026-09-15T10:00:00Z","payload":{"x":1}}'
curl -s -o /dev/null -w 'second:%{http_code}\n' -X POST http://127.0.0.1:8080/events -H 'content-type: application/json' -d '{"eventId":"bench_dup","type":"incident.created","occurredAt":"2026-09-15T10:00:00Z","payload":{"x":1}}'
sleep 1
curl -s http://127.0.0.1:8080/events/bench_dup

# 3) Exhaustion (faster knobs optional: MAX_ATTEMPTS=3 BASE_DELAY_MS=200)
curl -s -X POST http://127.0.0.1:8090/mode -H 'content-type: application/json' -d '{"mode":"fail"}'
curl -s -X POST http://127.0.0.1:8080/events -H 'content-type: application/json' -d '{"eventId":"bench_fail","type":"incident.created","occurredAt":"2026-09-15T10:00:00Z","payload":{"x":1}}'
# wait until attempts stop (~15s at defaults), then:
curl -s http://127.0.0.1:8080/events/bench_fail

# 4) Automated suite
npm test
```

**Observed results (from local runs / automated tests):**

- Success path: `status=delivered`, `attemptCount=1`, attempt `outcome=success`, `httpStatus=200`.
- Retry path: first attempt `retryable`/`503`, later attempt `success`; final `delivered`.
- Exhaustion: with continuous 503 and `MAX_ATTEMPTS=3` in tests, exactly 3 attempts, final `status=failed`; no further claims.
- Idempotent ingest: first POST `201`, second POST `200`; still a single delivery job (`attemptCount` not doubled).
- Automated suite: **5/5 tests passed** (`delivered on success`, `retry then delivered`, `failed after max attempts`, `idempotent ingest`, `permanent 4xx fails without retry`).

**Failure/recovery shown in the demo video:** receiver set to `fail` (503) → event accepted and first attempt recorded as retryable → receiver set back to `ok` → worker retries after backoff → final `delivered` with ordered attempt history. Reviewer can reproduce with the AC2 curl block above (use a **new** `eventId`).

## Architecture and data flow

Flow: **accept → store → deliver → inspect**

| Component | Responsibility |
| --- | --- |
| `src/http.ts` | `POST /events`, `GET /events/:eventId`, `GET /health` |
| `src/ingest.ts` | Validate + idempotent accept |
| `src/store.ts` | SQLite: events + attempts; claim/record |
| `src/delivery.ts` | Classify, send webhook, backoff, `runOnce` / poll loop |
| `src/domain.ts` | Types + validation |
| `src/fakereceiver.ts` | Local demo webhook (`ok` / `fail`) |
| `src/config.ts` / `src/index.ts` | Env + wiring |

```
Client --POST /events--> http --> ingest --> store (pending, due now)
Worker runOnce --> store.claimDue --> POST WEBHOOK_URL --> classify --> store.recordAttempt
Client --GET /events/:id--> http --> store (status + ordered attempts)
```

**States:** `pending` → `delivered` | `failed` (terminal; never reopened).  
**Job model:** the event row **is** the delivery job — one `eventId`, no separate jobs table.

**Delivery policy:**

- Success: HTTP 2xx → `delivered`
- Retryable: network/timeout; HTTP `408`, `429`, `5xx`
- Permanent: other `4xx` → `failed` immediately
- Bound: `MAX_ATTEMPTS` (default 5); backoff `BASE_DELAY_MS * 2^(n-1)`
- Concurrent duplicates: SQLite PK on `event_id`; losers return existing row
- Attempt retention: attempt number, start/finish time, outcome, httpStatus, error, short response snippet

## Technology choices

**Why this stack:** TypeScript/Node for readable types and fast reviewer setup; `node:http` to avoid framework noise; SQLite for crash-durable pending work and unique-key idempotency; in-process worker because a distributed queue is out of scope.

**Alternatives considered:** Go (stronger concurrency story, heavier for some reviewers); Express/Hono (unnecessary for three routes); Redis/Bull or Kafka (overkill for a single-process credibility exercise); in-memory only store (fails the persistence/restart expectation).

**Trade-offs accepted:** single-process worker (horizontal scale needs leases); `better-sqlite3` native addon; at-least-once across HTTP rather than exactly-once.

## Important decisions

1. **Event row is the job** — avoids a second jobs table and makes “one logical delivery per eventId” obvious.
2. **Explicit retry classification** — only temporary classes retry; other 4xx fail immediately so client errors don’t loop.
3. **`runOnce()` + zero base delay in tests** — deterministic AC coverage without sleep-based flakiness.
4. **At-least-once semantics** — honest about crash windows after HTTP 200 before commit; receivers should dedupe on `eventId`.

## Assumptions and limitations

- One process-wide `WEBHOOK_URL` (not multi-subscriber).
- Caller supplies stable `eventId`; we do not generate ids.
- Re-ingest returns existing event unchanged (second body ignored after id match).
- No auth, multi-tenancy, signing, dashboard, or manual replay (out of scope / unfinished by design).
- Claim hold uses a short `next_attempt_at` push; multi-worker production needs real leases.
- Crash after webhook 2xx but before `recordAttempt` can cause a duplicate delivery on restart.

## Production and scale

**What this submission does now:** single Node process, SQLite file, poll/claim loop, one webhook, structured console logs, bounded retries.

**What I would change first for production/scale:**

1. Move to Postgres (or similar) for multi-instance writers.
2. Add claim leases (`locked_by` / `locked_until`) so many workers can compete safely.
3. Per-endpoint concurrency limits + circuit breaker so one failing URL cannot consume all capacity.
4. Metrics/alerts: accepted/delivered/failed counts, pending depth, oldest-pending age, exhaustion rate, webhook latency.
5. Optional dead-letter / manual replay for terminal `failed` events; backoff jitter to reduce thundering herds.

## AI usage

Used **Cursor (Composer)** to help scaffold the TypeScript service, SQLite store, delivery worker, tests, README, and this submission document from the challenge brief and an agreed design plan.

I reviewed the resulting code and policies, ran `npm test`, and exercised success / retry / idempotent paths manually (curl/Postman). I remain responsible for everything in the submission.

## Credibility note

Describe one product or system you previously helped ship:

- **Problem:** At ASBL, inventory lived in MongoDB and needed a more structured PostgreSQL-backed Inventory Service for dependent production workloads.
- **Contribution:** I worked on APIs, ETL/migration scripts, dual-read/write flows, inventory history, and production deployment/observability.
- **Scale / complexity:** Multiple dependent services consuming inventory in production during a live migration between stores.
- **Difficult decision:** Maintaining consistency during cutover — we used **best-effort dual writes** with **ETL reconciliation** rather than a hard cutover, accepting temporary divergence windows in exchange for safer migration.
- **Evidence:** Code is proprietary; no public link is available.
