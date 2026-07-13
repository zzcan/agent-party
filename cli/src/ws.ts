import {
  EXIT_ARCHIVED,
  EXIT_AUTH,
  EXIT_ERROR,
  EXIT_LOOP_GUARD,
  EXIT_RATE_LIMITED,
  type ErrorCode,
  type SendFrame,
  type ServerFrame,
} from "@agentparty-mini/shared";
import { CliError } from "./errors";

export type HelloFrame = Extract<ServerFrame, { type: "hello" }>;

export interface OpenOpts {
  after?: number;
  reconnect?: boolean;
  reconnectDelaysMs?: number[];
}

export interface Channel {
  hello: HelloFrame;
  frames: AsyncIterable<ServerFrame>;
  send(frame: SendFrame): void;
  close(): void;
}

const DEFAULT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

export function toWsUrl(server: string, channel: string, token: string, after?: number): string {
  const base = server.replace(/^http/, "ws");
  const q = new URLSearchParams({ token });
  if (after !== undefined && after > 0) q.set("after", String(after));
  return `${base}/api/channels/${channel}/ws?${q.toString()}`;
}

function isTerminalCode(code: string): boolean {
  return code === "auth" || code === "archived";
}

export function exitCodeFor(code: ErrorCode): number {
  switch (code) {
    case "auth": return EXIT_AUTH;
    case "archived": return EXIT_ARCHIVED;
    case "loop_guard": return EXIT_LOOP_GUARD;
    case "rate_limited": return EXIT_RATE_LIMITED;
    default: return EXIT_ERROR;
  }
}
function terminalError(frame: Extract<ServerFrame, { type: "error" }>): CliError {
  const code = frame.code === "archived" ? EXIT_ARCHIVED : EXIT_AUTH;
  return new CliError(code, frame.message);
}

class FrameQueue implements AsyncIterable<ServerFrame> {
  private items: ServerFrame[] = [];
  private resolvers: ((r: IteratorResult<ServerFrame>) => void)[] = [];
  private done = false;
  push(f: ServerFrame) {
    const r = this.resolvers.shift();
    if (r) r({ value: f, done: false });
    else this.items.push(f);
  }
  finish() {
    this.done = true;
    let r;
    while ((r = this.resolvers.shift())) r({ value: undefined as never, done: true });
  }
  async *[Symbol.asyncIterator](): AsyncIterator<ServerFrame> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.done) return;
      const r = await new Promise<IteratorResult<ServerFrame>>((res) => this.resolvers.push(res));
      if (r.done) return;
      yield r.value;
    }
  }
}

export async function openChannel(
  cfg: { server: string; token: string },
  channel: string,
  opts: OpenOpts = {},
): Promise<Channel> {
  const queue = new FrameQueue();
  const delays = opts.reconnectDelaysMs ?? DEFAULT_DELAYS;
  let ws: WebSocket;
  let lastSeq = opts.after ?? 0;
  let closedByCaller = false;
  let gotFirstHello = false;
  let swallowHello = false; // 重连后的 hello 不入队
  let attempt = 0;
  let helloResolve!: (h: HelloFrame) => void;
  let helloReject!: (e: unknown) => void;
  const helloPromise = new Promise<HelloFrame>((res, rej) => {
    helloResolve = res;
    helloReject = rej;
  });

  const connect = () => {
    ws = new WebSocket(toWsUrl(cfg.server, channel, cfg.token, lastSeq));
    ws.addEventListener("message", (ev: MessageEvent) => {
      const frame = JSON.parse(String(ev.data)) as ServerFrame;
      if (frame.type === "hello") {
        if (!gotFirstHello) {
          gotFirstHello = true;
          helloResolve(frame);
        }
        // 无论首连还是重连，hello 本身不进 frames
        swallowHello = false;
        return;
      }
      if (!gotFirstHello && frame.type === "error") {
        helloReject(terminalError(frame));
        return;
      }
      if (frame.type === "msg") lastSeq = frame.seq;
      if (frame.type === "error" && isTerminalCode(frame.code)) {
        queue.push(frame);
        queue.finish();
        closedByCaller = true; // 阻止重连
        return;
      }
      queue.push(frame);
    });
    ws.addEventListener("close", () => {
      if (closedByCaller) {
        queue.finish();
        return;
      }
      if (!gotFirstHello) {
        // 首个 hello 都没拿到就断：视为连接失败
        helloReject(new CliError(EXIT_AUTH, "connection closed before hello"));
        return;
      }
      if (opts.reconnect) {
        const delay = delays[Math.min(attempt, delays.length - 1)];
        attempt++;
        swallowHello = true;
        setTimeout(connect, delay);
        return;
      }
      queue.finish();
    });
    ws.addEventListener("error", () => {
      // close 事件会随后到来，统一在 close 里处理
    });
  };

  connect();
  const hello = await helloPromise;
  return {
    hello,
    frames: queue,
    send: (f: SendFrame) => {
      ws.send(JSON.stringify(f));
    },
    close: () => {
      closedByCaller = true;
      ws.close();
    },
  };
}
