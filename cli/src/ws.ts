import { EXIT_ARCHIVED, EXIT_AUTH, type SendFrame, type ServerFrame } from "@agentparty-mini/shared";
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
  // message 类 send 在收到匹配 idem_key 的 sent 回执前视为「未确认」；
  // 断线重连窗口内发出的 send 可能在旧连接已被对端判定关闭后才真正写入 socket，
  // 从而被静默丢弃（TCP/WS 层不会对此抛错）。重连后对未确认的 message 重放，
  // 保证 reconnect:true 时 send() 的可靠投递（不依赖旧连接是否真正把字节发出去）。
  const unconfirmed = new Map<string, SendFrame>();
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
        } else if (swallowHello) {
          // 重连后拿到新连接的 hello：把重连窗口内可能被旧连接静默丢弃的
          // message 类 send 在新连接上重放一遍。
          for (const f of unconfirmed.values()) ws.send(JSON.stringify(f));
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
      if (frame.type === "sent") unconfirmed.delete(frame.idem_key);
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
      if (f.type === "send" && f.kind === "message") unconfirmed.set(f.idem_key, f);
      ws.send(JSON.stringify(f));
    },
    close: () => {
      closedByCaller = true;
      ws.close();
    },
  };
}
