import { loadConfig } from "./config.js";
import { Worker } from "./delivery.js";
import { createServer } from "./http.js";
import { Store } from "./store.js";

const config = loadConfig();
const store = new Store(config.databasePath);
const worker = new Worker(store, {
  webhookUrl: config.webhookUrl,
  maxAttempts: config.maxAttempts,
  baseDelayMs: config.baseDelayMs,
  deliveryTimeoutMs: config.deliveryTimeoutMs,
});

const server = createServer(store);
const port = Number(config.httpAddr);
server.listen(port, () => {
  console.log(`webhook-retry-engine listening on http://127.0.0.1:${port}`);
  console.log(`WEBHOOK_URL=${config.webhookUrl}`);
  console.log(`MAX_ATTEMPTS=${config.maxAttempts} BASE_DELAY_MS=${config.baseDelayMs}`);
});

worker.startLoop(config.pollIntervalMs);

function shutdown(): void {
  worker.stopLoop();
  server.close();
  store.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
