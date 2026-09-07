// @vitest-environment node
import http from "node:http";
import { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { createGatewayProxy } from "../../server/gateway-proxy";

const PROXY_PATH = "/api/gateway/ws";
const REAL_TOKEN = "operator-secret-token";

type Frame = Record<string, unknown>;
type Closeable = { close: () => Promise<void> };

const cleanups: Array<() => Promise<void>> = [];
const track = <T extends Closeable>(item: T): T => {
  cleanups.push(() => item.close());
  return item;
};

afterEach(async () => {
  while (cleanups.length) {
    const close = cleanups.pop();
    if (close) await close().catch(() => {});
  }
});

type GatewayBehavior = "ok" | "protocol" | "approval" | "no-operator-scope";

const startMockOpenclawGateway = async (
  options: { expectedToken?: string; behavior?: GatewayBehavior } = {}
) => {
  const expectedToken = options.expectedToken ?? REAL_TOKEN;
  const behavior = options.behavior ?? "ok";
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    let authed = false;
    ws.send(
      JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-abc" } })
    );

    ws.on("message", (raw) => {
      let frame: Frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame.type !== "req") return;
      const id = String(frame.id);
      const method = String(frame.method);
      const params = (frame.params ?? {}) as Frame;

      const resOk = (payload: Frame) => ws.send(JSON.stringify({ type: "res", id, ok: true, payload }));
      const resErr = (code: string, message: string) =>
        ws.send(JSON.stringify({ type: "res", id, ok: false, error: { code, message } }));

      if (method === "connect") {
        if (behavior === "protocol") {
          resErr("protocol_version_unsupported", "minProtocol 5 exceeds server maxProtocol 4");
          return;
        }
        if (behavior === "approval") {
          resErr("device_approval_required", "pairing required: approve this device in the dashboard");
          return;
        }
        const auth = (params.auth ?? {}) as Frame;
        const token = typeof auth.token === "string" ? auth.token : "";
        if (!token) {
          resErr("token_missing", "token_missing");
          return;
        }
        if (token !== expectedToken) {
          resErr("token_mismatch", "token_mismatch");
          return;
        }
        authed = true;
        if (behavior === "no-operator-scope") {
          resOk({
            type: "hello-ok",
            protocol: 4,
            adapterType: "openclaw",
            auth: { role: "viewer", scopes: ["chat.read"] },
            snapshot: { health: { agents: [{ agentId: "ceo", name: "CEO" }] } },
          });
          return;
        }
        resOk({
          type: "hello-ok",
          protocol: 4,
          adapterType: "openclaw",
          features: { methods: ["agents.list", "chat.send"], events: ["chat"] },
          auth: { role: "operator", scopes: ["operator.read", "operator.admin", "operator.approvals"] },
          snapshot: {
            health: {
              agents: [{ agentId: "ceo", name: "CEO", isDefault: true }],
              defaultAgentId: "ceo",
            },
            sessionDefaults: { mainKey: "main" },
          },
        });
        return;
      }

      if (!authed) {
        resErr("not_connected", "connect first");
        return;
      }

      if (method === "agents.list") {
        resOk({
          defaultId: "ceo",
          mainKey: "main",
          agents: [{ id: "ceo", name: "CEO", role: "Chief Executive", workspace: "/ceo" }],
        });
        return;
      }

      if (method === "chat.send") {
        const message = typeof params.message === "string" ? params.message : "";
        const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : "agent:ceo:main";
        resOk({ status: "started", runId: "run-1" });
        ws.send(
          JSON.stringify({
            type: "event",
            event: "chat",
            seq: 1,
            payload: {
              runId: "run-1",
              sessionKey,
              state: "final",
              message: { role: "assistant", content: `CEO echo: ${message}` },
            },
          })
        );
        return;
      }

      resOk({});
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const { port } = httpServer.address() as AddressInfo;

  return track({
    url: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => httpServer.close(() => resolve()));
      }),
  });
};

const startProxy = async (upstream: { url: string; token: string; adapterType?: string }) => {
  const proxy = createGatewayProxy({
    loadUpstreamSettings: async () => ({
      url: upstream.url,
      token: upstream.token,
      adapterType: upstream.adapterType ?? "openclaw",
    }),
    log: () => {},
    logError: () => {},
    upstreamHandshakeTimeoutMs: 1500,
  });

  const httpServer = http.createServer();
  httpServer.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] === PROXY_PATH) {
      proxy.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const { port } = httpServer.address() as AddressInfo;

  return track({
    url: `ws://127.0.0.1:${port}${PROXY_PATH}`,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  });
};

// Reserve then release a port so a connection to it is refused (ECONNREFUSED).
const reserveClosedUpstreamUrl = async () => {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `ws://127.0.0.1:${port}`;
};

// Minimal browser that mirrors GatewayBrowserClient's handshake: wait for the
// challenge (with an unprompted fallback, like the real client), then send the
// connect frame — optionally with a device-auth signature and/or a token.
class BrowserSim {
  private ws: WebSocket;
  private connectId = "connect-1";
  private connectResolve!: (frame: Frame) => void;
  private connectReject!: (err: Error) => void;
  private connectPromise: Promise<Frame>;
  private pending = new Map<string, (frame: Frame) => void>();
  private events: Frame[] = [];
  private connectSent = false;
  private fallbackTimer: NodeJS.Timeout;

  constructor(url: string, private opts: { includeDeviceAuth?: boolean; token?: string } = {}) {
    this.ws = new WebSocket(url);
    this.connectPromise = new Promise<Frame>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });

    this.fallbackTimer = setTimeout(() => this.sendConnect(), 300);

    this.ws.on("message", (raw) => {
      let frame: Frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame.type === "event" && frame.event === "connect.challenge") {
        clearTimeout(this.fallbackTimer);
        this.sendConnect();
        return;
      }
      if (frame.type === "res" && frame.id === this.connectId) {
        this.connectResolve(frame);
        return;
      }
      if (frame.type === "res" && typeof frame.id === "string" && this.pending.has(frame.id)) {
        this.pending.get(frame.id)!(frame);
        this.pending.delete(frame.id);
        return;
      }
      if (frame.type === "event") this.events.push(frame);
    });

    this.ws.on("close", () => {
      clearTimeout(this.fallbackTimer);
      this.connectReject(new Error("socket closed before connect response"));
    });
    this.ws.on("error", (err) => this.connectReject(err as Error));
  }

  private sendConnect() {
    if (this.connectSent || this.ws.readyState !== WebSocket.OPEN) return;
    this.connectSent = true;
    const params: Frame = {
      minProtocol: 3,
      maxProtocol: 4,
      client: { id: "openclaw-control-ui", version: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read", "operator.admin", "operator.approvals", "operator.pairing"],
      caps: [],
    };
    if (this.opts.includeDeviceAuth) {
      params.device = {
        id: "device-under-test",
        publicKey: "pk-under-test",
        signature: "sig-under-test",
        signedAt: Date.now(),
        nonce: "nonce-abc",
      };
    }
    if (this.opts.token) params.auth = { token: this.opts.token };
    this.ws.send(JSON.stringify({ type: "req", id: this.connectId, method: "connect", params }));
  }

  waitForConnect() {
    return this.connectPromise;
  }

  request(method: string, params: Frame = {}): Promise<Frame> {
    const id = `req-${Math.random().toString(16).slice(2)}`;
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 3000);
      this.pending.set(id, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
      this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  waitForEvent(predicate: (frame: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const start = Date.now();
    const found = this.events.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setInterval(() => {
        const match = this.events.find(predicate);
        if (match) {
          clearInterval(timer);
          resolve(match);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error("timeout waiting for event"));
        }
      }, 20);
    });
  }

  close() {
    clearTimeout(this.fallbackTimer);
    return Promise.resolve(this.ws.close());
  }
}

const connectBrowser = async (
  proxyUrl: string,
  opts: { includeDeviceAuth?: boolean; token?: string } = {}
) => {
  const browser = track(new BrowserSim(proxyUrl, opts));
  const connectRes = await browser.waitForConnect();
  return { browser, connectRes };
};

describe("gateway proxy diagnostics + OpenClaw handshake", () => {
  it("injects the server token even when the browser only presents device auth, and surfaces the ceo agent", async () => {
    const gateway = await startMockOpenclawGateway();
    const proxy = await startProxy({ url: gateway.url, token: REAL_TOKEN });

    // Regression: the browser never receives the token; it only sends a
    // device-auth signature. The proxy must still inject the shared token.
    const { connectRes } = await connectBrowser(proxy.url, { includeDeviceAuth: true });

    expect(connectRes.ok).toBe(true);
    const payload = connectRes.payload as Frame;
    expect(payload.type).toBe("hello-ok");
    expect((payload.auth as Frame).scopes).toContain("operator.admin");
    const agents = ((payload.snapshot as Frame)?.health as Frame)?.agents as Frame[];
    expect(agents.some((agent) => agent.agentId === "ceo")).toBe(true);
  });

  it("lists the real ceo agent and round-trips a chat message", async () => {
    const gateway = await startMockOpenclawGateway();
    const proxy = await startProxy({ url: gateway.url, token: REAL_TOKEN });
    const { browser, connectRes } = await connectBrowser(proxy.url, { includeDeviceAuth: true });
    expect(connectRes.ok).toBe(true);

    const listRes = await browser.request("agents.list");
    const agents = (listRes.payload as Frame).agents as Frame[];
    expect(agents.some((agent) => agent.id === "ceo")).toBe(true);

    const sendRes = await browser.request("chat.send", {
      sessionKey: "agent:ceo:main",
      message: "Say hello from the office",
    });
    expect(sendRes.ok).toBe(true);

    const finalEvent = await browser.waitForEvent(
      (frame) => frame.event === "chat" && (frame.payload as Frame)?.state === "final"
    );
    const content = ((finalEvent.payload as Frame).message as Frame).content as string;
    expect(content).toContain("Say hello from the office");
  });

  it("reports gateway_token_missing when no token is configured anywhere", async () => {
    const gateway = await startMockOpenclawGateway();
    const proxy = await startProxy({ url: gateway.url, token: "" });
    const { connectRes } = await connectBrowser(proxy.url, { includeDeviceAuth: false });
    expect(connectRes.ok).toBe(false);
    expect((connectRes.error as Frame).code).toBe("studio.gateway_token_missing");
  });

  it("reports gateway_invalid_token when the server token is wrong", async () => {
    const gateway = await startMockOpenclawGateway({ expectedToken: REAL_TOKEN });
    const proxy = await startProxy({ url: gateway.url, token: "the-wrong-token" });
    const { connectRes } = await connectBrowser(proxy.url, { includeDeviceAuth: true });
    expect(connectRes.ok).toBe(false);
    expect((connectRes.error as Frame).code).toBe("studio.gateway_invalid_token");
  });

  it("reports gateway_protocol_mismatch when the gateway rejects the protocol", async () => {
    const gateway = await startMockOpenclawGateway({ behavior: "protocol" });
    const proxy = await startProxy({ url: gateway.url, token: REAL_TOKEN });
    const { connectRes } = await connectBrowser(proxy.url, { includeDeviceAuth: true });
    expect(connectRes.ok).toBe(false);
    expect((connectRes.error as Frame).code).toBe("studio.gateway_protocol_mismatch");
  });

  it("reports gateway_approval_required when the device needs approval", async () => {
    const gateway = await startMockOpenclawGateway({ behavior: "approval" });
    const proxy = await startProxy({ url: gateway.url, token: REAL_TOKEN });
    const { connectRes } = await connectBrowser(proxy.url, { includeDeviceAuth: true });
    expect(connectRes.ok).toBe(false);
    expect((connectRes.error as Frame).code).toBe("studio.gateway_approval_required");
  });

  it("reports gateway_scope_missing when the session lacks operator scopes", async () => {
    const gateway = await startMockOpenclawGateway({ behavior: "no-operator-scope" });
    const proxy = await startProxy({ url: gateway.url, token: REAL_TOKEN });
    const { connectRes } = await connectBrowser(proxy.url, { includeDeviceAuth: true });
    expect(connectRes.ok).toBe(false);
    expect((connectRes.error as Frame).code).toBe("studio.gateway_scope_missing");
  });

  it("reports gateway_unreachable when the upstream refuses the connection", async () => {
    const closedUrl = await reserveClosedUpstreamUrl();
    const proxy = await startProxy({ url: closedUrl, token: REAL_TOKEN });
    const { connectRes } = await connectBrowser(proxy.url, { includeDeviceAuth: true });
    expect(connectRes.ok).toBe(false);
    expect((connectRes.error as Frame).code).toBe("studio.gateway_unreachable");
  });
});
