import type { SendFrame, ServerFrame } from "@agentparty-mini/shared";

export function wsUrl(server: string, slug: string, token: string, after: number): string {
  const base = server.replace(/^http/, "ws");
  return `${base}/api/channels/${slug}/ws?token=${encodeURIComponent(token)}&after=${after}`;
}

interface WsLike {
  onopen: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface OpenOpts {
  server: string;
  token: string;
  slug: string;
  after: number;
  onFrame: (frame: ServerFrame) => void;
  onOpen?: () => void;
  onClose?: () => void;
  reconnectDelaysMs?: number[];
  wsFactory?: (url: string) => WsLike;
}

export interface ChannelConn {
  send(frame: SendFrame): void;
  close(): void;
}

const DEFAULT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

export function openChannel(opts: OpenOpts): ChannelConn {
  const delays = opts.reconnectDelaysMs ?? DEFAULT_DELAYS;
  const factory = opts.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WsLike);
  let ws: WsLike;
  let after = opts.after;
  let closedByCaller = false;
  let stopReconnect = false;
  let attempt = 0;

  const connect = () => {
    ws = factory(wsUrl(opts.server, opts.slug, opts.token, after));
    ws.onopen = () => {
      attempt = 0;
      opts.onOpen?.();
    };
    ws.onmessage = (e) => {
      const frame = JSON.parse(e.data) as ServerFrame;
      if (frame.type === "msg") after = frame.seq;
      if (frame.type === "error" && (frame.code === "auth" || frame.code === "archived")) {
        stopReconnect = true;
      }
      opts.onFrame(frame);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      opts.onClose?.();
      if (closedByCaller || stopReconnect) return;
      const delay = delays[Math.min(attempt, delays.length - 1)];
      attempt++;
      setTimeout(connect, delay);
    };
  };
  connect();

  return {
    send: (frame) => ws.send(JSON.stringify(frame)),
    close: () => {
      closedByCaller = true;
      ws.close();
    },
  };
}
