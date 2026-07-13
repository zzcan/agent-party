import { SELF } from "cloudflare:test";
import type { ServerFrame } from "@agentparty-mini/shared";

export class WsClient {
  frames: ServerFrame[] = [];
  private cursor = 0;

  private constructor(public ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (e) => {
      this.frames.push(JSON.parse(e.data as string) as ServerFrame);
    });
  }

  static async connect(slug: string, token: string, after?: number): Promise<WsClient> {
    const url =
      `https://x/api/channels/${slug}/ws?token=${token}` + (after !== undefined ? `&after=${after}` : "");
    const res = await SELF.fetch(url, { headers: { upgrade: "websocket" } });
    if (res.status !== 101 || !res.webSocket) {
      throw new Error(`ws upgrade failed: ${res.status} ${await res.text()}`);
    }
    return new WsClient(res.webSocket);
  }

  send(frame: unknown) {
    this.ws.send(JSON.stringify(frame));
  }

  /** 从上次消费位置起找第一个匹配帧（消费式，保证能断言顺序） */
  async expect(pred: (f: ServerFrame) => boolean, ms = 5000): Promise<ServerFrame> {
    const deadline = Date.now() + ms;
    for (;;) {
      while (this.cursor < this.frames.length) {
        const f = this.frames[this.cursor++];
        if (pred(f)) return f;
      }
      if (Date.now() > deadline) {
        throw new Error(`timeout waiting for frame; received: ${JSON.stringify(this.frames)}`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  close() {
    this.ws.close();
  }
}
