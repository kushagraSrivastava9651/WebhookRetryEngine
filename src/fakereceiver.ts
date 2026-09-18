import http from "node:http";

/**
 * Local webhook for demos.
 * POST /webhook — receives deliveries
 * POST /mode {"mode":"ok"|"fail"} — toggle response
 * GET /mode — current mode
 * GET /received — list of received bodies
 */
let mode: "ok" | "fail" = "ok";
const received: unknown[] = [];

const port = Number(process.env.FAKE_RECEIVER_PORT ?? 8090);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/mode") {
    return send(res, 200, { mode });
  }

  if (req.method === "POST" && url.pathname === "/mode") {
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body || "{}") as { mode?: string };
      if (parsed.mode === "ok" || parsed.mode === "fail") {
        mode = parsed.mode;
        return send(res, 200, { mode });
      }
      return send(res, 400, { error: 'mode must be "ok" or "fail"' });
    } catch {
      return send(res, 400, { error: "invalid JSON" });
    }
  }

  if (req.method === "GET" && url.pathname === "/received") {
    return send(res, 200, { count: received.length, received });
  }

  if (req.method === "POST" && url.pathname === "/reset") {
    received.length = 0;
    mode = "ok";
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/webhook") {
    const body = await readBody(req);
    let parsed: unknown = body;
    try {
      parsed = JSON.parse(body);
    } catch {
      // keep raw
    }
    received.push(parsed);
    console.log(`fakereceiver mode=${mode} body=${body}`);
    if (mode === "fail") {
      return send(res, 503, { error: "temporary failure" });
    }
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: "not found" });
});

server.listen(port, () => {
  console.log(`fakereceiver listening on http://127.0.0.1:${port}`);
  console.log(`webhook URL: http://127.0.0.1:${port}/webhook`);
});

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
