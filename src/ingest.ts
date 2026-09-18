import type { EventPayload, EventRow } from "./domain.js";
import { validateEventBody } from "./domain.js";
import type { Store } from "./store.js";

export function acceptEvent(
  store: Store,
  body: unknown,
  now: Date = new Date(),
): { created: boolean; event: EventRow } {
  const payload: EventPayload = validateEventBody(body);
  return store.insertEvent(payload, now);
}
