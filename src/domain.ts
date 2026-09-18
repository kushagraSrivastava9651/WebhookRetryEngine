export type EventStatus = "pending" | "delivered" | "failed";
export type AttemptOutcome = "success" | "retryable" | "permanent";

export interface EventPayload {
  eventId: string;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface EventRow {
  eventId: string;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  status: EventStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttemptRow {
  id: number;
  eventId: string;
  attemptNumber: number;
  startedAt: string;
  finishedAt: string;
  outcome: AttemptOutcome;
  httpStatus: number | null;
  error: string | null;
  responseSnippet: string | null;
}

export interface EventDetail extends EventRow {
  attempts: AttemptRow[];
}

export function validateEventBody(body: unknown): EventPayload {
  if (body === null || typeof body !== "object") {
    throw new ValidationError("body must be a JSON object");
  }
  const o = body as Record<string, unknown>;
  const eventId = o.eventId;
  const type = o.type;
  const occurredAt = o.occurredAt;
  const payload = o.payload;

  if (typeof eventId !== "string" || eventId.trim() === "") {
    throw new ValidationError("eventId is required");
  }
  if (typeof type !== "string" || type.trim() === "") {
    throw new ValidationError("type is required");
  }
  if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) {
    throw new ValidationError("occurredAt must be an ISO-8601 timestamp");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ValidationError("payload must be an object");
  }

  return {
    eventId: eventId.trim(),
    type: type.trim(),
    occurredAt,
    payload: payload as Record<string, unknown>,
  };
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
