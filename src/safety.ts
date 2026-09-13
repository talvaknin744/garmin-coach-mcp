import { createHash } from "node:crypto";

const PRIVATE_KEY =
  /(?:address|cookie|coordinate|csrf|display.?name|email|first.?name|last.?name|latitude|longitude|password|polyline|session|token|user.?id|username)/i;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function redactForOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 100).map(redactForOutput);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !PRIVATE_KEY.test(key))
      .map(([key, item]) => [key, redactForOutput(item)])
  );
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  const token = process.env.GARMIN_TOKEN?.trim();
  return token
    ? message.replaceAll(token, "[redacted Garmin token]")
    : message;
}
