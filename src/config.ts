export interface Config {
  httpAddr: string;
  webhookUrl: string;
  databasePath: string;
  maxAttempts: number;
  baseDelayMs: number;
  deliveryTimeoutMs: number;
  pollIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const httpAddr = env.HTTP_ADDR ?? "8080";
  const webhookUrl = env.WEBHOOK_URL ?? "http://127.0.0.1:8090/webhook";
  const databasePath = env.DATABASE_PATH ?? "webhook.db";
  const maxAttempts = positiveInt(env.MAX_ATTEMPTS, 5);
  const baseDelayMs = nonNegativeInt(env.BASE_DELAY_MS ?? env.BASE_DELAY, 1000);
  const deliveryTimeoutMs = positiveInt(env.DELIVERY_TIMEOUT_MS, 5000);
  const pollIntervalMs = positiveInt(env.POLL_INTERVAL_MS, 200);

  return {
    httpAddr,
    webhookUrl,
    databasePath,
    maxAttempts,
    baseDelayMs,
    deliveryTimeoutMs,
    pollIntervalMs,
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`invalid positive integer: ${raw}`);
  }
  return Math.floor(n);
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`invalid non-negative integer: ${raw}`);
  }
  return Math.floor(n);
}
