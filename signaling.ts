import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

const PORT = Number(process.env.SIGNALING_PORT ?? 3001);

type Role = "desktop" | "phone";

type Description = { type?: string; sdp?: string };
type IceCandidate = { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null };

type SignalMessage =
  | { type: "join"; role: Role; room: string }
  | { type: "offer"; description: Description }
  | { type: "answer"; description: Description }
  | { type: "ice"; candidate: IceCandidate };

type Room = {
  desktop?: WSContext;
  phone?: WSContext;
};

const rooms = new Map<string, Room>();
const sockets = new Map<unknown, { role: Role; room: string; ws: WSContext }>();

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
          sockets.delete(id(existing));
        }

        room[msg.role] = ws;
        rooms.set(msg.room, room);
        sockets.set(id(ws), { role: msg.role, room: msg.room, ws });
        send(ws, { type: "joined", role: msg.role, room: msg.room });

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
});

injectWebSocket(server);
