import * as http from "http";

const PORT_START = 18510;
const PORT_END = 18519;

type RequestHandler = (
  method: string,
  params: unknown
) => Promise<unknown>;

export class HttpBridge {
  private server: http.Server | null = null;
  private handler: RequestHandler;
  private port = 0;
  private lastPollTime = 0;
  private pendingPolls: http.ServerResponse[] = [];
  private notificationQueue: Array<{ method: string; params?: unknown }> = [];

  constructor(handler: RequestHandler) {
    this.handler = handler;
  }

  async start(): Promise<number> {
    for (let port = PORT_START; port <= PORT_END; port++) {
      try {
        await this.tryListen(port);
        this.port = port;
        console.log(`[vsc-search] HTTP bridge listening on port ${port}`);
        return port;
      } catch {
        // Port busy, try next
      }
    }
    throw new Error(
      "No available port in range " + PORT_START + "-" + PORT_END
    );
  }

  private tryListen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });
      server.on("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        this.server = server;
        resolve();
      });
    });
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    // CORS headers for vscode-file:// origin
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/rpc") {
      this.handleRpc(req, res);
    } else if (req.method === "GET" && req.url === "/poll") {
      this.handlePoll(req, res);
    } else if (req.method === "GET") {
      // Health check / discovery endpoint
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", port: this.port }));
    } else {
      res.writeHead(404);
      res.end();
    }
  }

  private handleRpc(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      let id = 0;
      try {
        const msg = JSON.parse(body);
        id = msg.id || 0;
        const result = await this.handler(msg.method, msg.params);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id, result }));
      } catch (e) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id,
            error: e instanceof Error ? e.message : String(e),
          })
        );
      }
    });
  }

  private handlePoll(
    _req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    this.lastPollTime = Date.now();

    // If there are queued notifications, return immediately
    if (this.notificationQueue.length > 0) {
      const notifications = this.notificationQueue.splice(0);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ notifications }));
      return;
    }

    // Hold the connection until a notification arrives or timeout
    this.pendingPolls.push(res);

    const timeout = setTimeout(() => {
      const idx = this.pendingPolls.indexOf(res);
      if (idx >= 0) {
        this.pendingPolls.splice(idx, 1);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ notifications: [] }));
      }
    }, 30000);

    _req.on("close", () => {
      clearTimeout(timeout);
      const idx = this.pendingPolls.indexOf(res);
      if (idx >= 0) this.pendingPolls.splice(idx, 1);
    });
  }

  /** Send a notification to the renderer via long-poll */
  notify(method: string, params?: unknown): void {
    const notification = { method, params };

    // If there are waiting poll requests, respond immediately
    if (this.pendingPolls.length > 0) {
      const res = this.pendingPolls.shift()!;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ notifications: [notification] }));
      return;
    }

    // Otherwise queue the notification
    this.notificationQueue.push(notification);
  }

  /** True if renderer has polled within the last 35 seconds */
  get isConnected(): boolean {
    return this.server != null && Date.now() - this.lastPollTime < 35000;
  }

  stop(): void {
    // Respond to all pending polls
    for (const res of this.pendingPolls) {
      try {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ notifications: [] }));
      } catch {}
    }
    this.pendingPolls = [];

    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
