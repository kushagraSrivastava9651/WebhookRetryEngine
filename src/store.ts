import Database from "better-sqlite3";
import type {
  AttemptOutcome,
  AttemptRow,
  EventDetail,
  EventPayload,
  EventRow,
  EventStatus,
} from "./domain.js";

interface EventDbRow {
  event_id: string;
  type: string;
  occurred_at: string;
  payload: string;
  status: EventStatus;
  attempt_count: number;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AttemptDbRow {
  id: number;
  event_id: string;
  attempt_number: number;
  started_at: string;
  finished_at: string;
  outcome: AttemptOutcome;
  http_status: number | null;
  error: string | null;
  response_snippet: string | null;
}

export interface RecordAttemptInput {
  eventId: string;
  attemptNumber: number;
  startedAt: string;
  finishedAt: string;
  outcome: AttemptOutcome;
  httpStatus: number | null;
  error: string | null;
  responseSnippet: string | null;
  /** New event status after this attempt. */
  status: EventStatus;
  /** Next attempt time when still pending; null when terminal. */
  nextAttemptAt: string | null;
}

export class Store {
  readonly db: Database.Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_due
        ON events (status, next_attempt_at);

      CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL REFERENCES events(event_id),
        attempt_number INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'retryable', 'permanent')),
        http_status INTEGER,
        error TEXT,
        response_snippet TEXT,
        UNIQUE (event_id, attempt_number)
      );
    `);
  }

  insertEvent(input: EventPayload, now: Date = new Date()): { created: boolean; event: EventRow } {
    const nowIso = now.toISOString();
    const insert = this.db.prepare(`
      INSERT INTO events (
        event_id, type, occurred_at, payload, status,
        attempt_count, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `);

    try {
      insert.run(
        input.eventId,
        input.type,
        input.occurredAt,
        JSON.stringify(input.payload),
        nowIso,
        nowIso,
        nowIso,
      );
      return { created: true, event: this.getEvent(input.eventId)! };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE") {
        const existing = this.getEvent(input.eventId);
        if (!existing) throw err;
        return { created: false, event: existing };
      }
      throw err;
    }
  }

  getEvent(eventId: string): EventRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM events WHERE event_id = ?`)
      .get(eventId) as EventDbRow | undefined;
    return row ? mapEvent(row) : undefined;
  }

  getEventWithAttempts(eventId: string): EventDetail | undefined {
    const event = this.getEvent(eventId);
    if (!event) return undefined;
    const rows = this.db
      .prepare(
        `SELECT * FROM attempts WHERE event_id = ? ORDER BY attempt_number ASC`,
      )
      .all(eventId) as AttemptDbRow[];
    return { ...event, attempts: rows.map(mapAttempt) };
  }

  /**
   * Claim one due pending event. Marks next_attempt_at far ahead briefly so
   * another poller in the same process does not double-claim before recordAttempt.
   */
  claimDue(now: Date = new Date()): EventRow | undefined {
    const nowIso = now.toISOString();
    const claim = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `
          SELECT * FROM events
          WHERE status = 'pending'
            AND next_attempt_at IS NOT NULL
            AND next_attempt_at <= ?
          ORDER BY next_attempt_at ASC
          LIMIT 1
        `,
        )
        .get(nowIso) as EventDbRow | undefined;
      if (!row) return undefined;

      // Hold: push next_attempt_at so concurrent RunOnce calls skip this row.
      const holdUntil = new Date(now.getTime() + 60_000).toISOString();
      this.db
        .prepare(
          `UPDATE events SET next_attempt_at = ?, updated_at = ? WHERE event_id = ? AND status = 'pending'`,
        )
        .run(holdUntil, nowIso, row.event_id);

      return mapEvent({ ...row, next_attempt_at: holdUntil, updated_at: nowIso });
    });
    return claim();
  }

  recordAttempt(input: RecordAttemptInput): EventRow {
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO attempts (
            event_id, attempt_number, started_at, finished_at,
            outcome, http_status, error, response_snippet
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          input.eventId,
          input.attemptNumber,
          input.startedAt,
          input.finishedAt,
          input.outcome,
          input.httpStatus,
          input.error,
          input.responseSnippet,
        );

      this.db
        .prepare(
          `
          UPDATE events
          SET status = ?,
              attempt_count = ?,
              next_attempt_at = ?,
              updated_at = ?
          WHERE event_id = ?
        `,
        )
        .run(
          input.status,
          input.attemptNumber,
          input.nextAttemptAt,
          input.finishedAt,
          input.eventId,
        );

      return this.getEvent(input.eventId)!;
    });
    return write();
  }
}

function mapEvent(row: EventDbRow): EventRow {
  return {
    eventId: row.event_id,
    type: row.type,
    occurredAt: row.occurred_at,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAttempt(row: AttemptDbRow): AttemptRow {
  return {
    id: row.id,
    eventId: row.event_id,
    attemptNumber: row.attempt_number,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome,
    httpStatus: row.http_status,
    error: row.error,
    responseSnippet: row.response_snippet,
  };
}
