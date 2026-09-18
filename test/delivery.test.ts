import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { Worker } from "../src/delivery.js";
import { acceptEvent } from "../src/ingest.js";
import { Store } from "../src/store.js";

function tempDb(): string {
  return path.join(
    os.tmpdir(),
    `webhook-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
}

function sampleEvent(eventId: string) {
  return {
    eventId,
    type: "incident.created",
    occurredAt: "2026-09-15T10:00:00Z",
    payload: { incidentId: "inc_456", severity: "high" },
  };
}

async function withFakeWebhook(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const url = `http://127.0.0.1:${addr.port}/webhook`;
  try {
    await fn(url);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

describe("delivery", () => {
  const paths: string[] = [];

  after(() => {
    for (const p of paths) {
      try {
        fs.unlinkSync(p);
      } catch {
        // ignore
      }
      for (const suffix of ["-wal", "-shm"]) {
        try {
          fs.unlinkSync(p + suffix);
        } catch {
          // ignore
        }
      }
    }
  });

  test("delivered on success", async () => {
    const dbPath = tempDb();
    paths.push(dbPath);
    let hits = 0;

    await withFakeWebhook((_req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }, async (url) => {
      const store = new Store(dbPath);
      const worker = new Worker(store, {
        webhookUrl: url,
        maxAttempts: 5,
        baseDelayMs: 0,
        deliveryTimeoutMs: 2000,
      });

      acceptEvent(store, sampleEvent("evt_ok"));
      const did = await worker.runOnce();
      assert.equal(did, true);

      const detail = store.getEventWithAttempts("evt_ok");
      assert.ok(detail);
      assert.equal(detail.status, "delivered");
      assert.equal(detail.attemptCount, 1);
      assert.equal(detail.attempts.length, 1);
      assert.equal(detail.attempts[0]!.outcome, "success");
      assert.equal(hits, 1);
      store.close();
    });
  });

  test("retry then delivered", async () => {
    const dbPath = tempDb();
    paths.push(dbPath);
    let hits = 0;

    await withFakeWebhook((_req, res) => {
      hits += 1;
      if (hits === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "busy" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }, async (url) => {
      const store = new Store(dbPath);
      const worker = new Worker(store, {
        webhookUrl: url,
        maxAttempts: 5,
        baseDelayMs: 0,
        deliveryTimeoutMs: 2000,
      });

      acceptEvent(store, sampleEvent("evt_retry"));
      assert.equal(await worker.runOnce(), true);
      let detail = store.getEventWithAttempts("evt_retry")!;
      assert.equal(detail.status, "pending");
      assert.equal(detail.attempts.length, 1);
      assert.equal(detail.attempts[0]!.outcome, "retryable");

      assert.equal(await worker.runOnce(), true);
      detail = store.getEventWithAttempts("evt_retry")!;
      assert.equal(detail.status, "delivered");
      assert.equal(detail.attemptCount, 2);
      assert.equal(detail.attempts.length, 2);
      assert.equal(detail.attempts[1]!.outcome, "success");
      assert.equal(hits, 2);
      store.close();
    });
  });

  test("failed after max attempts", async () => {
    const dbPath = tempDb();
    paths.push(dbPath);
    let hits = 0;

    await withFakeWebhook((_req, res) => {
      hits += 1;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "down" }));
    }, async (url) => {
      const store = new Store(dbPath);
      const maxAttempts = 3;
      const worker = new Worker(store, {
        webhookUrl: url,
        maxAttempts,
        baseDelayMs: 0,
        deliveryTimeoutMs: 2000,
      });

      acceptEvent(store, sampleEvent("evt_exhaust"));
      for (let i = 0; i < maxAttempts; i++) {
        assert.equal(await worker.runOnce(), true);
      }
      assert.equal(await worker.runOnce(), false);

      const detail = store.getEventWithAttempts("evt_exhaust")!;
      assert.equal(detail.status, "failed");
      assert.equal(detail.attemptCount, maxAttempts);
      assert.equal(detail.attempts.length, maxAttempts);
      assert.ok(detail.attempts.every((a) => a.outcome === "retryable"));
      assert.equal(hits, maxAttempts);
      store.close();
    });
  });

  test("idempotent ingest", async () => {
    const dbPath = tempDb();
    paths.push(dbPath);
    let hits = 0;

    await withFakeWebhook((_req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }, async (url) => {
      const store = new Store(dbPath);
      const worker = new Worker(store, {
        webhookUrl: url,
        maxAttempts: 5,
        baseDelayMs: 0,
        deliveryTimeoutMs: 2000,
      });

      const first = acceptEvent(store, sampleEvent("evt_idem"));
      const second = acceptEvent(store, sampleEvent("evt_idem"));
      assert.equal(first.created, true);
      assert.equal(second.created, false);
      assert.equal(first.event.eventId, second.event.eventId);

      assert.equal(await worker.runOnce(), true);
      assert.equal(await worker.runOnce(), false);

      const detail = store.getEventWithAttempts("evt_idem")!;
      assert.equal(detail.status, "delivered");
      assert.equal(detail.attempts.length, 1);
      assert.equal(hits, 1);
      store.close();
    });
  });

  test("permanent 4xx fails without retry", async () => {
    const dbPath = tempDb();
    paths.push(dbPath);
    let hits = 0;

    await withFakeWebhook((_req, res) => {
      hits += 1;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad" }));
    }, async (url) => {
      const store = new Store(dbPath);
      const worker = new Worker(store, {
        webhookUrl: url,
        maxAttempts: 5,
        baseDelayMs: 0,
        deliveryTimeoutMs: 2000,
      });

      acceptEvent(store, sampleEvent("evt_perm"));
      assert.equal(await worker.runOnce(), true);
      assert.equal(await worker.runOnce(), false);

      const detail = store.getEventWithAttempts("evt_perm")!;
      assert.equal(detail.status, "failed");
      assert.equal(detail.attempts.length, 1);
      assert.equal(detail.attempts[0]!.outcome, "permanent");
      assert.equal(hits, 1);
      store.close();
    });
  });
});
