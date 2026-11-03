/**
 * A fetch-based Server-Sent Events reader for the extension host.
 *
 * Node has no EventSource, and NEO's stream is simple: `data: {json}` frames, `: keepalive`
 * comments every 15 seconds, and a `{kind: "hello"}` frame first. Like EventSource this reconnects
 * on its own, but with a bounded backoff, and like EventSource it does not replay — the caller is
 * told about every (re)open so it can catch up from NEO's history.
 */

export interface SseHandlers {
  /** The stream is open and its first frame arrived. `reconnect` is false only for the first. */
  onOpen(reconnect: boolean): void;
  onEvent(data: unknown): void;
  /** The connection dropped or could not be made; another attempt follows after `retryInMs`. */
  onDown(error: unknown, retryInMs: number): void;
}

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
// NEO sends a keepalive every 15s. Nothing for three of those means the socket is dead without
// having said so — a sleeping laptop leaves exactly that behind.
const SILENCE_LIMIT_MS = 45_000;

export class SseStream {
  private controller: AbortController | undefined;
  private stopped = false;
  private attempt = 0;
  private opened = false;
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(private readonly url: string, private readonly handlers: SseHandlers) {}

  start(): void {
    this.stop();
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.controller?.abort();
    this.controller = undefined;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const controller = new AbortController();
    this.controller = controller;
    let silence: NodeJS.Timeout | undefined;
    const arm = () => {
      if (silence) clearTimeout(silence);
      silence = setTimeout(() => controller.abort(new Error("stream silent for 45s")), SILENCE_LIMIT_MS);
    };

    try {
      arm();
      const res = await fetch(this.url, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream answered HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let announced = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (this.stopped || this.controller !== controller) return;   // superseded mid-read
        arm();
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = frameData(frame);
          if (data === undefined) continue;          // a keepalive comment
          if (!announced) {
            announced = true;
            this.attempt = 0;
            const reconnect = this.opened;
            this.opened = true;
            this.handlers.onOpen(reconnect);
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;                                // one bad frame must not end the stream
          }
          this.handlers.onEvent(parsed);
        }
      }
      throw new Error("stream closed by the server");
    } catch (err) {
      // Superseded by a stop() or a newer start(): this attempt must not schedule a second stream.
      if (this.stopped || this.controller !== controller) return;
      const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
      this.attempt += 1;
      this.handlers.onDown(err, wait);
      this.retryTimer = setTimeout(() => void this.connect(), wait);
    } finally {
      if (silence) clearTimeout(silence);
    }
  }
}

/** The `data:` payload of one SSE frame, or undefined for a frame that carries none. */
function frameData(frame: string): string | undefined {
  const lines = frame
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""));
  return lines.length ? lines.join("\n") : undefined;
}
