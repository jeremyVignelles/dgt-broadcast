import { SerialPort } from "serialport";
import type { ByteTransport } from "./client.ts";

export class SerialTransport implements ByteTransport {
  private readonly port: SerialPort;
  constructor(path: string) {
    this.port = new SerialPort({
      path,
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      rtscts: false,
      xon: false,
      xoff: false,
      autoOpen: false,
      lock: true,
    });
  }
  open(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.port.open((error) => (error ? reject(error) : resolve())),
    );
  }
  write(bytes: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) =>
      this.port.write(Buffer.from(bytes), (error) => (error ? reject(error) : resolve())),
    );
  }
  close(): Promise<void> {
    if (!this.port.isOpen) return Promise.resolve();
    return new Promise((resolve, reject) =>
      this.port.close((error) => (error ? reject(error) : resolve())),
    );
  }
  onData(listener: (bytes: Uint8Array) => void): () => void {
    this.port.on("data", listener);
    return () => this.port.removeListener("data", listener);
  }
  onError(listener: (error: Error) => void): () => void {
    this.port.on("error", listener);
    return () => this.port.removeListener("error", listener);
  }
  onClose(listener: () => void): () => void {
    this.port.on("close", listener);
    return () => this.port.removeListener("close", listener);
  }
}
