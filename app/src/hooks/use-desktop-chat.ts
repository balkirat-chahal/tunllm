import { useCallback, useEffect, useRef, useState } from "react";

export type ChatStatus = "connecting" | "waiting" | "connected" | "error";

export type ChatLine = {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
};

type SignalIn = {
  type: string;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  message?: string;
};

function iceServers(): RTCIceServer[] {
  return [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: `stun:${window.location.hostname}:3478` },
  ];
}

function signalingUrl() {
  const port = import.meta.env.VITE_SIGNALING_PORT ?? "3001";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.hostname}:${port}/ws`;
}

function serializeCandidate(candidate: RTCIceCandidate) {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment,
  };
}

export function useDesktopChat(room = "tunllm") {
  const [status, setStatus] = useState<ChatStatus>("connecting");
  const [messages, setMessages] = useState<ChatLine[]>([]);
  const [pending, setPending] = useState(false);
  const channelRef = useRef<RTCDataChannel | null>(null);

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let pc: RTCPeerConnection | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const closePeer = () => {
      pc?.close();
      pc = null;
      channelRef.current = null;
    };

    const connect = () => {
      if (cancelled) return;
      setStatus("connecting");
      ws = new WebSocket(signalingUrl());

      const send = (payload: unknown) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
      };

      const startCall = async () => {
        closePeer();
        pc = new RTCPeerConnection({ iceServers: iceServers() });
        const channel = pc.createDataChannel("ollama");
        channelRef.current = channel;

        channel.onopen = () => {
          if (!cancelled) setStatus("connected");
        };
        channel.onclose = () => {
          if (!cancelled) {
            channelRef.current = null;
            setStatus("waiting");
            setPending(false);
          }
        };
        channel.onmessage = (event) => {
          const payload = JSON.parse(String(event.data)) as {
            type: "assistant" | "error";
            content: string;
          };
          setPending(false);
          setMessages((current) => [
            ...current,
            {
              id: crypto.randomUUID(),
              role: payload.type === "error" ? "error" : "assistant",
              content: payload.content,
            },
          ]);
        };

        pc.onicecandidate = (event) => {
          if (event.candidate) send({ type: "ice", candidate: serializeCandidate(event.candidate) });
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({
          type: "offer",
          description: { type: pc.localDescription?.type, sdp: pc.localDescription?.sdp },
        });
      };

      ws.onopen = () => send({ type: "join", role: "phone", room });

      ws.onmessage = async (event) => {
        const msg = JSON.parse(String(event.data)) as SignalIn;
        if (msg.type === "error") {
          setStatus("error");
          return;
        }
        if (msg.type === "joined") {
          setStatus("waiting");
          return;
        }
        if (msg.type === "ready") {
          await startCall();
          return;
        }
        if (msg.type === "answer" && msg.description && pc) {
          await pc.setRemoteDescription(msg.description);
          return;
        }
        if (msg.type === "ice" && msg.candidate && pc) {
          try {
            await pc.addIceCandidate(msg.candidate);
          } catch {
            // trickle candidates can arrive before remote description
          }
          return;
        }
        if (msg.type === "peer-left") {
          closePeer();
          setStatus("waiting");
          setPending(false);
        }
      };

      ws.onclose = () => {
        closePeer();
        if (cancelled) return;
        setStatus("error");
        retry = setTimeout(connect, 1000);
      };
    };

    connect();

    return () => {
      cancelled = true;
      clearTimeout(retry);
      ws?.close();
      closePeer();
    };
  }, [room]);

  const sendMessage = useCallback((content: string) => {
    const channel = channelRef.current;
    if (!channel || channel.readyState !== "open") return false;
    channel.send(JSON.stringify({ type: "user", content }));
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", content }]);
    setPending(true);
    return true;
  }, []);

  return { status, messages, pending, sendMessage };
}
