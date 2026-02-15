import { WebSocketServer, WebSocket } from "ws";
import * as http from "http";

type RequestHandler = (
  method: string,
  params: unknown
) => Promise<unknown>;

interface BridgeClient {
  ws: WebSocket;
  windowId: number | null;
  verified: boolean;
}

export class WsBridge {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private handler: RequestHandler;
  private nonce: string;
  private port = 0;
  private client: BridgeClient | null = null;

  constructor(handler: RequestHandler, nonce: string) {
    this.handler = handler;
    this.nonce = nonce;
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer();
      const wss = new WebSocketServer({ server });

      wss.on("connection", (ws) => {
        this.handleConnection(ws);
      });

      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        this.httpServer = server;
        this.wss = wss;
        const addr = server.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        console.log(`[vsc-search] WebSocket bridge listening on port ${this.port}`);
        resolve(this.port);
      });
    });
  }

  get listeningPort(): number {
    return this.port;
  }

  get isConnected(): boolean {
    return this.client?.verified === true && this.client.ws.readyState === WebSocket.OPEN;
  }

  get windowId(): number | null {
    return this.client?.windowId ?? null;
  }

  private handleConnection(ws: WebSocket): void {
    // Send welcome with nonce for DOM verification
    ws.send(JSON.stringify({ type: "welcome", nonce: this.nonce }));

    ws.on("message", (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case "verified":
          this.onVerified(ws, msg.windowId as number);
          break;
        case "reconnect":
          this.onReconnect(ws, msg.windowId as number);
          break;
        case "rpc":
          this.onRpc(ws, msg);
          break;
        default:
          break;
      }
    });

    ws.on("close", () => {
      if (this.client?.ws === ws) {
        console.log("[vsc-search] Client disconnected (windowId=" + this.client.windowId + ")");
        this.client = null;
      }
    });
  }

  private onVerified(ws: WebSocket, windowId: number): void {
    // Disconnect previous client if any
    if (this.client && this.client.ws !== ws) {
      try { this.client.ws.close(); } catch {}
    }
    this.client = { ws, windowId, verified: true };
    console.log(`[vsc-search] Client verified (windowId=${windowId})`);
  }

  private onReconnect(ws: WebSocket, windowId: number): void {
    // Disconnect previous client if any
    if (this.client && this.client.ws !== ws) {
      try { this.client.ws.close(); } catch {}
    }
    this.client = { ws, windowId, verified: true };
    // Send welcome to confirm reconnection
    ws.send(JSON.stringify({ type: "welcome", nonce: this.nonce }));
    console.log(`[vsc-search] Client reconnected (windowId=${windowId})`);
  }

  private async onRpc(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const id = msg.id as number;
    const method = msg.method as string;
    const params = msg.params;

    try {
      const result = await this.handler(method, params);
      ws.send(JSON.stringify({ type: "rpc_result", id, result }));
    } catch (e) {
      ws.send(JSON.stringify({
        type: "rpc_error",
        id,
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  }

  /** Send a notification to the connected renderer */
  notify(method: string, params?: unknown): void {
    if (!this.client || this.client.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.client.ws.send(
      JSON.stringify({ type: "notify", method, params })
    );
  }

  stop(): void {
    if (this.client) {
      try { this.client.ws.close(); } catch {}
      this.client = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
  }
}
