import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
/** Isolated hardware boundary. Commands are fixed and never shell-interpolated. */
export class RfcommTransport extends EventEmitter {
  private readonly device: string;
  constructor(device: string) {
    super();
    this.device = device;
    if (!/^DGT_BT_[A-Za-z0-9_-]+$/.test(device)) throw new Error("Invalid DGT device id");
  }
  connect(): void {
    const child = spawn("rfcomm", ["connect", this.device], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", (error) => this.emit("error", error));
    child.stdout.on("data", (data) => this.emit("data", data));
  }
}
