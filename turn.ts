import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

const require = createRequire(import.meta.url);
const Turn = require("node-turn") as {
  new (options?: {
    listeningPort?: number;
    listeningIps?: string[];
    relayIps?: string[];
    externalIps?: string | Record<string, string> | null;
    minPort?: number;
    maxPort?: number;
    authMech?: "none" | "short-term" | "long-term";
    realm?: string;
    credentials?: Record<string, string>;
    debugLevel?: "OFF" | "FATAL" | "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE" | "ALL";
  }): {
    start: () => void;
    addUser: (username: string, password: string) => void;
    removeUser: (username: string) => void;
  };
};

const PORT = Number(process.env.TURN_PORT ?? 3479);
const API_PORT = Number(process.env.TURN_API_PORT ?? 3480);
const API_HOST = process.env.TURN_API_HOST ?? "127.0.0.1";
const API_SECRET = process.env.TURN_API_SECRET ?? "tunllm-turn-api";
const REALM = process.env.TURN_REALM ?? "tunllm";
const RELAY_MIN = Number(process.env.TURN_RELAY_PORT_MIN ?? 49152);
const RELAY_MAX = Number(process.env.TURN_RELAY_PORT_MAX ?? 49251);
const DEFAULT_TTL = Number(process.env.TURN_CREDENTIAL_TTL ?? 3600);

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((iface): iface is NetworkInterfaceInfo =>
      Boolean(iface && !iface.internal && iface.family === "IPv4"),
    )
    .map((iface) => iface.address);
}

const advertisedIp = process.env.TURN_EXTERNAL_IP ?? lanAddresses()[0] ?? "127.0.0.1";
const expirations = new Map<string, ReturnType<typeof setTimeout>>();

function authorized(header: string | undefined) {
  return header === `Bearer ${API_SECRET}`;
}

function dropUser(username: string) {
  const timer = expirations.get(username);
  if (timer) clearTimeout(timer);
  expirations.delete(username);
  turn.removeUser(username);
}

function mintUser(ttl: number) {
  const username = `${Math.floor(Date.now() / 1000) + ttl}:${randomBytes(8).toString("hex")}`;
  const credential = randomBytes(18).toString("base64url");
  turn.addUser(username, credential);
  expirations.set(
    username,
    setTimeout(() => dropUser(username), ttl * 1000),
  );
  return { username, credential, ttl };
}

// TURN only forwards already-encrypted DTLS datagrams between peers.
// It never terminates WebRTC, so it cannot read prompts or replies.
// Static long-term passwords are not used; signaling mints per-session users.
const turn = new Turn({
  listeningPort: PORT,
  relayIps: advertisedIp === "127.0.0.1" ? undefined : [advertisedIp],
  externalIps: advertisedIp,
  minPort: RELAY_MIN,
  maxPort: RELAY_MAX,
  authMech: "long-term",
  realm: REALM,
  credentials: {},
  debugLevel: "ERROR",
});

turn.start();

const api = new Hono();

api.post("/credentials", async (c) => {
  if (!authorized(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { ttl?: number };
  const ttl = Math.min(Math.max(Number(body.ttl ?? DEFAULT_TTL), 60), 86400);
  return c.json(mintUser(ttl));
});

api.delete("/credentials/:username", (c) => {
  if (!authorized(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
  dropUser(c.req.param("username"));
  return c.json({ ok: true });
});

serve({ fetch: api.fetch, hostname: API_HOST, port: API_PORT }, () => {
  console.log(`turn listening udp 0.0.0.0:${PORT} advertised ${advertisedIp}`);
  console.log(`turn api http://${API_HOST}:${API_PORT} realm ${REALM} relay ${RELAY_MIN}-${RELAY_MAX}`);
});
