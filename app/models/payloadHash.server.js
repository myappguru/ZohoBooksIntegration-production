import crypto from "node:crypto";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

// Order-insensitive (for object keys) hash of a Zoho payload.
export function payloadHash(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex");
}
