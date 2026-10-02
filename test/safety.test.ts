import assert from "node:assert/strict";
import test from "node:test";

import { canonicalHash, errorMessage, redactForOutput } from "../src/safety.js";

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

test("error messages redact the raw Garmin token", () => {
  const previous = process.env.GARMIN_TOKEN;
  process.env.GARMIN_TOKEN = "secret-garmin-token";
  try {
    assert.equal(
      errorMessage(new Error("request contained secret-garmin-token")),
      "request contained [redacted Garmin secret]"
    );
  } finally {
    if (previous === undefined) delete process.env.GARMIN_TOKEN;
    else process.env.GARMIN_TOKEN = previous;
  }
});

test("error messages redact Garmin login credentials", () => {
  const previousEmail = process.env.GARMIN_EMAIL;
  const previousPassword = process.env.GARMIN_PASSWORD;
  process.env.GARMIN_EMAIL = "owner@example.com";
  process.env.GARMIN_PASSWORD = "private-password";
  try {
    const message = errorMessage(
      new Error("login failed for owner@example.com with private-password")
    );
    assert.equal(
      message,
      "login failed for [redacted Garmin secret] with [redacted Garmin secret]"
    );
  } finally {
    if (previousEmail === undefined) delete process.env.GARMIN_EMAIL;
    else process.env.GARMIN_EMAIL = previousEmail;
    if (previousPassword === undefined) delete process.env.GARMIN_PASSWORD;
    else process.env.GARMIN_PASSWORD = previousPassword;
  }
});
