import { EventEmitter } from "node:events";
import { Command, FrameParser, decode } from "./protocol.ts";
import type { DecodedMessage } from "./protocol.ts";

export interface ByteTransport {
  open(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  onData(listener: (bytes: Uint8Array) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onClose(listener: () => void): () => void;
}
export class RequestTimeout extends Error {}
interface Pending {
  kind: DecodedMessage["kind"];
  resolve: (message: DecodedMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** One reader owns the stream; requests and unsolicited updates share its decoder. */
export class DgtClient extends EventEmitter {
  private readonly transport: ByteTransport;
  private readonly parser = new FrameParser();
  private pending?: Pending;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly unsubscribe: Array<() => void>;
  readonly metrics = {
    rxBytes: 0,
    txBytes: 0,
    messages: 0,
    protocolErrors: 0,
    timeouts: 0,
    requests: 0,
    retries: 0,
    lastRxAt: undefined as string | undefined,
    lastResponseMs: undefined as number | undefined,
    maxResponseMs: 0,
  };

  constructor(transport: ByteTransport) {
    super();
    this.transport = transport;
    this.unsubscribe = [
      transport.onData((bytes) => this.receive(bytes)),
      transport.onError((error) => this.fail(error)),
      transport.onClose(() => {
        if (!this.closed) this.fail(new Error("Liaison série DGT fermée"));
        this.closed = true;
        this.emit("closed");
      }),
    ];
  }
  async open(): Promise<void> {
    await this.transport.open();
  }
  private receive(bytes: Uint8Array): void {
    if (this.closed) return;
    this.metrics.rxBytes += bytes.length;
    this.metrics.lastRxAt = new Date().toISOString();
    this.emit("raw", { direction: "rx", bytes });
    const { frames, errors } = this.parser.push(bytes);
    for (const error of errors) this.protocolError(new Error(error));
    for (const frame of frames) {
      let message: DecodedMessage;
      try {
        message = decode(frame);
      } catch (error) {
        this.protocolError(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      this.metrics.messages++;
      const pending = this.pending;
      if (pending && message.kind === pending.kind) {
        clearTimeout(pending.timer);
        this.pending = undefined;
        pending.resolve(message);
      }
      this.emit("message", message);
    }
  }
  private protocolError(error: Error): void {
    this.metrics.protocolErrors++;
    this.emit("protocol-error", error);
  }
  private fail(error: Error): void {
    this.closed = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
    this.emit("fault", error);
  }
  async send(command: number): Promise<void> {
    if (this.closed) throw new Error("Client DGT fermé");
    const bytes = Uint8Array.of(command);
    this.metrics.txBytes++;
    this.emit("raw", { direction: "tx", bytes });
    await this.transport.write(bytes);
  }
  request(
    command: number,
    kind: DecodedMessage["kind"],
    timeoutMs = 3000,
    attempts = 1,
  ): Promise<DecodedMessage> {
    const attempt = async () => {
      if (this.closed) throw new Error("Client DGT fermé");
      this.metrics.requests++;
      const started = performance.now();
      const response = new Promise<DecodedMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending = undefined;
          this.metrics.timeouts++;
          reject(
            new RequestTimeout(`Délai dépassé pour la commande DGT 0x${command.toString(16)}`),
          );
        }, timeoutMs);
        this.pending = { kind, resolve, reject, timer };
      });
      // Attach rejection handling before writing: transports can fail synchronously.
      const written = this.send(command).catch((error: unknown) => {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      });
      const [message] = await Promise.all([response, written]);
      const elapsed = Math.round(performance.now() - started);
      this.metrics.lastResponseMs = elapsed;
      this.metrics.maxResponseMs = Math.max(this.metrics.maxResponseMs, elapsed);
      return message;
    };
    const run = async () => {
      for (let index = 0; index < attempts; index++) {
        try {
          return await attempt();
        } catch (error) {
          if (!(error instanceof RequestTimeout) || index === attempts - 1) throw error;
          this.metrics.retries++;
          this.emit("retry", { command, attempt: index + 2, error });
        }
      }
      throw new Error("Nombre de tentatives DGT invalide");
    };
    const result = this.queue.then(run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  readPosition(timeoutMs = 3000) {
    return this.request(Command.position, "position", timeoutMs, 2);
  }
  readClock() {
    return this.request(Command.clock, "clock");
  }
  readBattery() {
    return this.request(Command.battery, "battery");
  }
  readHistory() {
    return this.request(Command.history, "history", 20_000);
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error("Client DGT fermé"));
      this.pending = undefined;
    }
    try {
      await this.transport.close();
    } finally {
      for (const unsubscribe of this.unsubscribe) unsubscribe();
    }
  }
}
