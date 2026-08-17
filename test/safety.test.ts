import assert from "node:assert/strict";
import test from "node:test";

import { canonicalHash, redactForOutput } from "../src/safety.js";

test("canonical hash ignores object key order", () => {
  assert.equal(canonicalHash({ a: 1, b: 2 }), canonicalHash({ b: 2, a: 1 }));
});

test("output redaction removes identity, GPS, and session material", () => {
  const redacted = JSON.stringify(
    redactForOutput({
      displayName: "person",
      email: "secret@example.com",
      latitude: 1,
      longitude: 2,
      cookies: [{ value: "secret" }],
      csrfToken: "secret",
      nested: { restingHeartRate: 55, bodyBattery: 70 },
    })
  );
  assert.doesNotMatch(
    redacted,
    /person|example|latitude|longitude|cookie|csrf|secret/i
  );
  assert.match(redacted, /restingHeartRate/);
  assert.match(redacted, /bodyBattery/);
});
