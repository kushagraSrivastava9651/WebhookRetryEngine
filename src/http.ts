import http from "node:http";
import { ValidationError } from "./domain.js";
import { acceptEvent } from "./ingest.js";
import type { Store } from "./store.js";

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/events") {
        const body = await readJson(req);
        const { created, event } = acceptEvent(store, body);
        const detail = store.getEventWithAttempts(event.eventId)!;
        return json(res, created ? 201 : 200, formatDetail(detail));
      }

      const match = url.pathname.match(/^\/events\/([^/]+)$/);
      if (req.method === "GET" && match) {
        const eventId = decodeURIComponent(match[1]!);
        const detail = store.getEventWithAttempts(eventId);
        if (!detail) {
          return json(res, 404, { error: "event not found" });
        }
        return json(res, 200, formatDetail(detail));
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof ValidationError) {
        return json(res, 400, { error: err.message });
      }
      console.error(err);
      json(res, 500, { error: "internal error" });
    }
  });
}

function formatDetail(detail: NonNullable<ReturnType<Store["getEventWithAttempts"]>>) {
  return {
    eventId: detail.eventId,
    type: detail.type,
    occurredAt: detail.occurredAt,
    payload: detail.payload,
    status: detail.status,
    attemptCount: detail.attemptCount,
    nextAttemptAt: detail.nextAttemptAt,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    attempts: detail.attempts.map((a) => ({
      attemptNumber: a.attemptNumber,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
      outcome: a.outcome,
      httpStatus: a.httpStatus,
      error: a.error,
      responseSnippet: a.responseSnippet,
    })),
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ValidationError("body must be valid JSON");
  }
}
