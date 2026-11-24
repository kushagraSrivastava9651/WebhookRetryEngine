# 🔁 Webhook Retry Engine

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js_20+-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?style=flat-square&logo=sqlite&logoColor=white)
![Tests](https://img.shields.io/badge/tests-5%2F5_passing-brightgreen?style=flat-square)

A small, durable webhook delivery service in TypeScript. It accepts events, stores them in SQLite, delivers each one to a webhook URL with **bounded exponential-backoff retries**, and lets you inspect the **full attempt history** of every event.

> Built for a product engineering challenge. Design notes, trade-offs and a demo video are in [SUBMISSION.md](./SUBMISSION.md).

## ✨ Highlights

- **Idempotent ingest**: `eventId` is the primary key. A duplicate `POST` returns `200` with the existing event, so you never get a second delivery job.
- **Retry classification**: network errors, timeouts, `408`, `429` and `5xx` are retried. Other `4xx` responses fail at once, so client errors don't loop forever.
- **Bounded backoff**: `delay = BASE_DELAY_MS × 2^(n-1)`, up to `MAX_ATTEMPTS`. After that the event moves to the terminal state `failed`.
- **Crash-durable**: pending work lives in SQLite, so it survives a restart.
- **Inspectable**: every attempt records its number, timings, outcome, HTTP status, error and a short snippet of the response.
- **Deterministic tests**: the tests use `Worker.runOnce()` against an in-process fake receiver, with no sleeps and no external services.
- **Honest semantics**: delivery is *at-least-once* across the HTTP boundary, so receivers should dedupe on `eventId`.

## 🏗️ Architecture

```
            POST /events                         claimDue()
 Client ───────────────▶ http ─▶ ingest ─▶ SQLite ◀──────── Worker (poll loop)
                                   (pending, due now)          │
                                                               │ POST WEBHOOK_URL
 Client ◀─────────────── http ◀── SQLite ◀── recordAttempt ◀───┘ classify: success / retryable / permanent
         GET /events/:id   (status + ordered attempts)
```

**State machine:** `pending` → `delivered` | `failed` (both terminal)

| Module | Responsibility |
| --- | --- |
| `src/http.ts` | `POST /events`, `GET /events/:eventId`, `GET /health` |
| `src/ingest.ts` | Validation + idempotent accept |
| `src/store.ts` | SQLite events + attempts, claim/record |
| `src/delivery.ts` | Send, classify, backoff, `runOnce` / poll loop |
| `src/fakereceiver.ts` | Local demo receiver you can switch between `ok` and `fail` |

## 🚀 Next Steps for Production

Postgres with claim leases (`locked_by` / `locked_until`) so multiple workers can run safely · per-endpoint circuit breakers · backoff jitter · dead-letter queue + manual replay · metrics (pending depth, oldest-pending age, exhaustion rate).

---


## Requirements

- Node.js 20+
- npm

## Setup (~2 minutes)

```bash
npm install
```

## Run demo (two terminals)

**Terminal 1 — fake webhook receiver**

```bash
npm run fakereceiver
```

Listens on `http://127.0.0.1:8090`. Webhook path: `/webhook`.

**Terminal 2 — engine**

```bash
WEBHOOK_URL=http://127.0.0.1:8090/webhook npm start
```

API listens on `http://127.0.0.1:8080` by default.

## Acceptance scenarios (curl)

### AC1 — Successful delivery

```bash
curl -s -X POST http://127.0.0.1:8080/events \
  -H 'content-type: application/json' \
  -d '{
    "eventId": "evt_ok_1",
    "type": "incident.created",
    "occurredAt": "2026-09-15T10:00:00Z",
    "payload": { "incidentId": "inc_456", "severity": "high" }
  }' | jq .

# wait a moment for the worker, then:
curl -s http://127.0.0.1:8080/events/evt_ok_1 | jq .
```

Expect `status: "delivered"` and one attempt with `outcome: "success"`.

### AC2 — Temporary failure then retry

```bash
# make receiver fail
curl -s -X POST http://127.0.0.1:8090/mode \
  -H 'content-type: application/json' \
  -d '{"mode":"fail"}'

curl -s -X POST http://127.0.0.1:8080/events \
  -H 'content-type: application/json' \
  -d '{
    "eventId": "evt_retry_1",
    "type": "incident.created",
    "occurredAt": "2026-09-15T10:00:00Z",
    "payload": { "incidentId": "inc_789", "severity": "medium" }
  }' | jq .

curl -s http://127.0.0.1:8080/events/evt_retry_1 | jq .

# restore receiver, wait for backoff retry (default BASE_DELAY_MS=1000)
curl -s -X POST http://127.0.0.1:8090/mode \
  -H 'content-type: application/json' \
  -d '{"mode":"ok"}'

sleep 2
curl -s http://127.0.0.1:8080/events/evt_retry_1 | jq .
```

### AC3 — Bounded failure

Keep mode `fail`, submit a new `eventId`, wait until `attemptCount` reaches `MAX_ATTEMPTS` (default 5). Status becomes `failed`; no further attempts.

For a faster demo:

```bash
MAX_ATTEMPTS=3 BASE_DELAY_MS=200 WEBHOOK_URL=http://127.0.0.1:8090/webhook npm start
```

### AC4 — Idempotent ingest

```bash
curl -s -o /tmp/a.json -w '%{http_code}\n' -X POST http://127.0.0.1:8080/events \
  -H 'content-type: application/json' \
  -d '{"eventId":"evt_dup","type":"incident.created","occurredAt":"2026-09-15T10:00:00Z","payload":{"x":1}}'

curl -s -o /tmp/b.json -w '%{http_code}\n' -X POST http://127.0.0.1:8080/events \
  -H 'content-type: application/json' \
  -d '{"eventId":"evt_dup","type":"incident.created","occurredAt":"2026-09-15T10:00:00Z","payload":{"x":1}}'
```

First response `201`, second `200`. Same logical event; one delivery job.

### AC5 — Inspect history

```bash
curl -s http://127.0.0.1:8080/events/evt_ok_1 | jq .
```

## Tests

```bash
npm test
```

Uses an in-process fake HTTP server and `runOnce()` — no flaky sleeps, no paid services.

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `HTTP_ADDR` | `8080` | API port |
| `WEBHOOK_URL` | `http://127.0.0.1:8090/webhook` | Delivery target |
| `DATABASE_PATH` | `webhook.db` | SQLite file |
| `MAX_ATTEMPTS` | `5` | Attempt budget |
| `BASE_DELAY_MS` | `1000` | Backoff base (`delay = base * 2^(n-1)`) |
| `DELIVERY_TIMEOUT_MS` | `5000` | Outbound HTTP timeout |
| `POLL_INTERVAL_MS` | `200` | Worker poll interval |

See [SUBMISSION.md](./SUBMISSION.md) for policies, semantics, and trade-offs.
