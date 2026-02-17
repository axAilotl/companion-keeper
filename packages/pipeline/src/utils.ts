import { access } from "node:fs/promises";
import path from "node:path";

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push(item);
    }
  }
  return out;
}

export function counterIncrement(counter: Map<string, number>, key: string, amount = 1): void {
  const current = counter.get(key) ?? 0;
  counter.set(key, current + amount);
}

export function mapToSortedRecord(map: Map<string, number>): Record<string, number> {
  const entries = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  const out: Record<string, number> = {};
  for (const [key, value] of entries) {
    out[key] = value;
  }
  return out;
}

export function sanitizeFilename(name: string): string {
  const sanitized = name.replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "unknown";
}

export function formatDateFromUnix(ts: number | null): string {
  if (ts === null) {
    return "unknown-date";
  }
  const date = new Date(ts * 1000);
  if (Number.isNaN(date.getTime())) {
    return "unknown-date";
  }
  const y = date.getUTCFullYear().toString().padStart(4, "0");
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${d}`;
}

export function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    return null;
  }
  return ms / 1000;
}

export function parseListArg(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\u0000/g, "");
}

export async function uniquePath(basePath: string): Promise<string> {
  let candidate = basePath;
  const parsed = path.parse(basePath);
  let suffix = 2;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await access(candidate);
      candidate = path.join(parsed.dir, `${parsed.name}_${suffix}${parsed.ext}`);
      suffix += 1;
    } catch {
      return candidate;
    }
  }
}
