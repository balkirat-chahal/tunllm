import { RTCPeerConnection } from "node-datachannel/polyfill";

const SIGNALING_URL = process.env.SIGNALING_URL ?? "ws://127.0.0.1:3001/ws";
const ROOM = process.env.ROOM ?? "tunllm";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";

type ChatMessage = { role: "user" | "assistant"; content: string };

type ChannelPayload =
  | { type: "user"; content: string }
  | { type: "assistant"; content: string }
  | { type: "error"; content: string };

type SignalIn = {
  type: string;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  iceServers?: RTCIceServer[];
  message?: string;
};

let model = process.env.OLLAMA_MODEL;

function serializeCandidate(candidate: RTCIceCandidate) {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment,
  };
}

async function resolveModel() {
  if (model) return model;
  const res = await fetch(`${OLLAMA_URL}/api/tags`);
  if (!res.ok) throw new Error(`ollama tags failed: ${res.status}`);
  const body = (await res.json()) as {
    models?: { name: string; size?: number; capabilities?: string[] }[];
  };
  const chatModels = (body.models ?? [])
    .filter((item) => {
      const caps = item.capabilities ?? [];
      return (
        caps.includes("completion") &&
        !caps.includes("embedding") &&
        !item.name.includes("embed") &&
        !item.name.includes("docling")
      );
    })
    .sort((a, b) => (a.size ?? Number.MAX_SAFE_INTEGER) - (b.size ?? Number.MAX_SAFE_INTEGER));
  const first = chatModels[0]?.name ?? body.models?.find((item) => item.capabilities?.includes("completion"))?.name;
  if (!first) throw new Error("no ollama chat models installed");
  model = first;
  console.log("ollama model", model);
  return first;
}

async function askOllama(messages: ChatMessage[]) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: await resolveModel(),
      messages,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`ollama chat failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { message?: { content?: string } };
  return body.message?.content ?? "";
}

function sendSignal(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

async function logIcePath(pc: RTCPeerConnection) {
  try {
    const stats = await pc.getStats();
    for (const report of stats.values()) {
      const pair = report as {
        type: string;
        nominated?: boolean;
        localCandidateId?: string;
        remoteCandidateId?: string;
      };
      if (pair.type !== "candidate-pair" || !pair.nominated) continue;
      const local = stats.get(pair.localCandidateId ?? "") as { candidateType?: string } | undefined;
      const remote = stats.get(pair.remoteCandidateId ?? "") as { candidateType?: string } | undefined;
      console.log(`ice ${local?.candidateType ?? "?"} -> ${remote?.candidateType ?? "?"}`);
    }
  } catch {
    // node-datachannel stats are optional
  }
}

function connect() {
  const ws = new WebSocket(SIGNALING_URL);
  let pc: RTCPeerConnection | null = null;
  let iceServers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];
  let iceReady = false;
  let pendingOffer: RTCSessionDescriptionInit | undefined;
  const history: ChatMessage[] = [];

  const closePeer = () => {
    pc?.close();
    pc = null;
    history.length = 0;
  };

  const acceptOffer = async (description: RTCSessionDescriptionInit) => {
    closePeer();
    pc = new RTCPeerConnection({ iceServers });

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) sendSignal(ws, { type: "ice", candidate: serializeCandidate(candidate) });
    };

    pc.oniceconnectionstatechange = () => {
      if (pc?.iceConnectionState === "connected" || pc?.iceConnectionState === "completed") {
        void logIcePath(pc);
      }
    };

    pc.ondatachannel = ({ channel }) => {
      console.log("data channel", channel.label);

      channel.onmessage = async ({ data }) => {
        let payload: ChannelPayload;
        try {
          payload = JSON.parse(String(data)) as ChannelPayload;
        } catch {
          channel.send(JSON.stringify({ type: "error", content: "invalid json" } satisfies ChannelPayload));
          return;
        }
        if (payload.type !== "user") return;

        console.log("prompt", payload.content);
        history.push({ role: "user", content: payload.content });
        try {
          const content = await askOllama(history);
          history.push({ role: "assistant", content });
          console.log("reply", content.slice(0, 120));
          channel.send(JSON.stringify({ type: "assistant", content } satisfies ChannelPayload));
        } catch (err) {
          const content = err instanceof Error ? err.message : String(err);
          console.error("ollama", content);
          channel.send(JSON.stringify({ type: "error", content } satisfies ChannelPayload));
        }
      };
    };

    await pc.setRemoteDescription(description);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal(ws, {
      type: "answer",
      description: { type: pc.localDescription?.type, sdp: pc.localDescription?.sdp },
    });
  };

  ws.addEventListener("open", () => {
    console.log(`desktop signaling ${SIGNALING_URL} room=${ROOM}`);
    sendSignal(ws, { type: "join", role: "desktop", room: ROOM });
  });

  ws.addEventListener("message", async (event) => {
    const msg = JSON.parse(String(event.data)) as SignalIn;

    if (msg.type === "error") {
      console.error("signaling", msg.message);
      return;
    }

    if (msg.type === "joined" || msg.type === "ready") {
      console.log(msg.type);
      return;
    }

    if (msg.type === "ice-config" && msg.iceServers) {
      iceServers = msg.iceServers;
      iceReady = true;
      console.log("ice-config", iceServers.length, "servers");
      if (pendingOffer) {
        const offer = pendingOffer;
        pendingOffer = undefined;
        await acceptOffer(offer);
      }
      return;
    }

    if (msg.type === "peer-left") {
      console.log("phone left");
      closePeer();
      return;
    }

    if (msg.type === "offer" && msg.description) {
      if (!iceReady) {
        pendingOffer = msg.description;
        return;
      }
      await acceptOffer(msg.description);
      return;
    }

    if (msg.type === "ice" && msg.candidate && pc) {
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch (err) {
        console.error("ice", err);
      }
    }
  });

  ws.addEventListener("close", () => {
    closePeer();
    console.log("signaling closed, retrying");
    setTimeout(connect, 1000);
  });

  ws.addEventListener("error", () => {
    console.error("signaling error");
  });
}

connect();
