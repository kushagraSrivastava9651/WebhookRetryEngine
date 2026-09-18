import type { AttemptOutcome, EventRow, EventStatus } from "./domain.js";
import type { Store } from "./store.js";

export interface DeliveryConfig {
  webhookUrl: string;
  maxAttempts: number;
  baseDelayMs: number;
  deliveryTimeoutMs: number;
}

export interface SendResult {
  httpStatus: number | null;
  error: string | null;
  responseSnippet: string | null;
  outcome: AttemptOutcome;
}

export function classifyOutcome(
  httpStatus: number | null,
  networkError: string | null,
): AttemptOutcome {
  if (networkError !== null) return "retryable";
  if (httpStatus === null) return "retryable";
  if (httpStatus >= 200 && httpStatus < 300) return "success";
  if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) {
    return "retryable";
  }
  // Other 4xx (and anything else non-2xx under 500 that isn't 408/429)
  return "permanent";
}

export function nextAttemptAt(
  now: Date,
  attemptNumberJustCompleted: number,
  baseDelayMs: number,
): Date {
  const delay = baseDelayMs * 2 ** (attemptNumberJustCompleted - 1);
  return new Date(now.getTime() + delay);
}

export async function sendWebhook(
  webhookUrl: string,
  event: EventRow,
  timeoutMs: number,
): Promise<SendResult> {
  const body = JSON.stringify({
    eventId: event.eventId,
    type: event.type,
    occurredAt: event.occurredAt,
    payload: event.payload,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    const snippet = text.slice(0, 200);
    const outcome = classifyOutcome(res.status, null);
    return {
      httpStatus: res.status,
      error: outcome === "success" ? null : `HTTP ${res.status}`,
      responseSnippet: snippet || null,
      outcome,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      httpStatus: null,
      error: message,
      responseSnippet: null,
      outcome: classifyOutcome(null, message),
    };
  } finally {
    clearTimeout(timer);
  }
}

export class Worker {
  private readonly store: Store;
  private readonly config: DeliveryConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(store: Store, config: DeliveryConfig) {
    this.store = store;
    this.config = config;
  }

  /** One claim → deliver → record cycle. Returns true if work was done. */
  async runOnce(now: Date = new Date()): Promise<boolean> {
    const event = this.store.claimDue(now);
    if (!event) return false;

    const attemptNumber = event.attemptCount + 1;
    const startedAt = now.toISOString();
    const result = await sendWebhook(
      this.config.webhookUrl,
      event,
      this.config.deliveryTimeoutMs,
    );
    const finished = new Date();
    const finishedAt = finished.toISOString();

    let status: EventStatus;
    let next: string | null;

    if (result.outcome === "success") {
      status = "delivered";
      next = null;
    } else if (result.outcome === "permanent") {
      status = "failed";
      next = null;
    } else if (attemptNumber >= this.config.maxAttempts) {
      status = "failed";
      next = null;
    } else {
      status = "pending";
      next = nextAttemptAt(
        finished,
        attemptNumber,
        this.config.baseDelayMs,
      ).toISOString();
    }

    this.store.recordAttempt({
      eventId: event.eventId,
      attemptNumber,
      startedAt,
      finishedAt,
      outcome: result.outcome,
      httpStatus: result.httpStatus,
      error: result.error,
      responseSnippet: result.responseSnippet,
      status,
      nextAttemptAt: next,
    });

    console.log(
      `event_id=${event.eventId} attempt=${attemptNumber} outcome=${result.outcome} status=${status}`,
    );
    return true;
  }

  startLoop(pollIntervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, pollIntervalMs);
    // Kick immediately.
    void this.tick();
  }

  stopLoop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Drain due work without sleeping between items.
      while (await this.runOnce()) {
        // continue
      }
    } catch (err) {
      console.error("delivery tick error", err);
    } finally {
      this.running = false;
    }
  }
}
