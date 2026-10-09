import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

const PORT = Number(process.env.SIGNALING_PORT ?? 3001);
const TURN_API_URL = process.env.TURN_API_URL ?? "http://127.0.0.1:3480";
const TURN_API_SECRET = process.env.TURN_API_SECRET ?? "tunllm-turn-api";
const TURN_PORT = process.env.TURN_PORT ?? "3479";
const STUN_PORT = process.env.STUN_PORT ?? "3478";

type Role = "desktop" | "phone";

type Description = { type?: string; sdp?: string };
type IceCandidate = { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null };

type SignalMessage =
  | { type: "join"; role: Role; room: string }
  | { type: "offer"; description: Description }
  | { type: "answer"; description: Description }
  | { type: "ice"; candidate: IceCandidate };

type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

type Room = {
  desktop?: WSContext;
  phone?: WSContext;
};

type Client = { role: Role; room: string; ws: WSContext; turnUser?: string };

const rooms = new Map<string, Room>();
const sockets = new Map<unknown, Client>();

function id(ws: WSContext) {
  return ws.raw ?? ws;
}

function send(ws: WSContext, payload: unknown) {
  ws.send(JSON.stringify(payload));
}

function otherPeer(room: Room, role: Role) {
  return role === "desktop" ? room.phone : room.desktop;
}

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((iface): iface is NetworkInterfaceInfo =>
      Boolean(iface && !iface.internal && iface.family === "IPv4"),
    )
    .map((iface) => iface.address);
}

const publicHost = process.env.TURN_PUBLIC_HOST ?? process.env.TURN_EXTERNAL_IP ?? lanAddresses()[0] ?? "127.0.0.1";

function stunServers(): IceServer[] {
  return [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: `stun:${publicHost}:${STUN_PORT}` },
  ];
}

async function mintTurn() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const res = await fetch(`${TURN_API_URL}/credentials`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TURN_API_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: 3600 }),
      });
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as { username: string; credential: string };
    } catch (err) {
      if (attempt === 9) {
        console.error("turn mint failed", err instanceof Error ? err.message : err);
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return null;
}

async function revokeTurn(username: string | undefined) {
  if (!username) return;
  try {
    await fetch(`${TURN_API_URL}/credentials/${encodeURIComponent(username)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TURN_API_SECRET}` },
    });
  } catch {
    // TURN process may already be gone
  }
}

function iceServers(turn: { username: string; credential: string } | null): IceServer[] {
  const servers = stunServers();
  if (turn) {
    servers.push({
      urls: `turn:${publicHost}:${TURN_PORT}?transport=udp`,
      username: turn.username,
      credential: turn.credential,
    });
  }
  return servers;
}

async function pushIceConfig(ws: WSContext) {
  const turn = await mintTurn();
  const meta = sockets.get(id(ws));
  if (meta) meta.turnUser = turn?.username;
  send(ws, { type: "ice-config", iceServers: iceServers(turn) });
}

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.get("/", (c) => c.json({ ok: true, rooms: [...rooms.keys()] }));

app.get(
  "/ws",
  upgradeWebSocket(() => ({
    onMessage(event, ws) {
      const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);

      let msg: SignalMessage;
      try {
        msg = JSON.parse(text) as SignalMessage;
      } catch {
        send(ws, { type: "error", message: "invalid json" });
        return;
      }

      if (msg.type === "join") {
        const room = rooms.get(msg.room) ?? {};
        const existing = room[msg.role];
        if (existing && id(existing) !== id(ws)) {
          const old = sockets.get(id(existing));
          void revokeTurn(old?.turnUser);
          sockets.delete(id(existing));
        }

        room[msg.role] = ws;
        rooms.set(msg.room, room);
        sockets.set(id(ws), { role: msg.role, room: msg.room, ws });
        send(ws, { type: "joined", role: msg.role, room: msg.room });
        void pushIceConfig(ws);

        if (room.desktop && room.phone) {
          send(room.phone, { type: "ready" });
          send(room.desktop, { type: "ready" });
        }
        return;
      }

      const meta = sockets.get(id(ws));
      if (!meta) {
        send(ws, { type: "error", message: "join a room first" });
        return;
      }

      const room = rooms.get(meta.room);
      const peer = room ? otherPeer(room, meta.role) : undefined;
      if (!peer) return;
      send(peer, msg);
    },
    onClose(_event, ws) {
      const meta = sockets.get(id(ws));
      if (!meta) return;
      sockets.delete(id(ws));
      void revokeTurn(meta.turnUser);

      const room = rooms.get(meta.room);
      if (!room) return;
      if (room[meta.role] && id(room[meta.role]!) === id(ws)) delete room[meta.role];

      const peer = otherPeer(room, meta.role);
      if (peer) send(peer, { type: "peer-left", role: meta.role });
      if (!room.desktop && !room.phone) rooms.delete(meta.room);
    },
  })),
);

const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port: PORT }, () => {
  console.log(`signaling ws://127.0.0.1:${PORT}/ws`);
  for (const ip of lanAddresses()) {
    console.log(`signaling ws://${ip}:${PORT}/ws`);
  }
  console.log(`signaling ice host ${publicHost}`);
});

injectWebSocket(server);
