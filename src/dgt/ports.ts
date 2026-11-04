const LINUX_PORT = /^\/dev\/(?:ttyUSB\d+|ttyACM\d+|rfcomm\d+|serial\/by-id\/[^/]+)$/;
const WINDOWS_PORT = /^COM[1-9]\d{0,2}$/i;

/** Accepts /dev/... paths on Linux and COMn names on Windows. */
export function isValidSerialPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" ? WINDOWS_PORT.test(path) : LINUX_PORT.test(path);
}

export const SERIAL_PATH_EXAMPLE = process.platform === "win32" ? "COM3" : "/dev/rfcomm0";
