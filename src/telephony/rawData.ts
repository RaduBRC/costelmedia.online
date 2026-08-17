/** Normalizes `ws`'s `RawData` (Buffer | ArrayBuffer | Buffer[]) into a UTF-8 string — every message on both WebSocket legs here is JSON text, never binary. */
import type { RawData } from "ws";

export function rawDataToUtf8String(data: RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}
