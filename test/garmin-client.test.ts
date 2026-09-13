import assert from "node:assert/strict";
import test from "node:test";

import {
  assertGarminConfig,
  GarminApiError,
  GarminClient,
  type GarminResponse,
} from "../src/garmin-client.js";

const TOKEN = "garmin-test-token-that-must-never-appear";

function response(
  status: number,
  text = "{}",
  content = Buffer.from(text)
): GarminResponse {
  return { status, text, content };
}

test("requires GARMIN_TOKEN without printing or echoing its value", () => {
  const missing = () =>
    assertGarminConfig({
      GARMIN_API_BASE_URL: "https://connectapi.garmin.com",
    });
  assert.throws(
    missing,
    (error: unknown) =>
      error instanceof Error &&
      /GARMIN_TOKEN/.test(error.message) &&
      !error.message.includes(TOKEN)
  );
  assert.throws(
    () =>
      assertGarminConfig({
        GARMIN_TOKEN: "   ",
        GARMIN_API_BASE_URL: "https://connectapi.garmin.com",
      }),
    (error: unknown) =>
      error instanceof Error &&
      /GARMIN_TOKEN/.test(error.message) &&
      !error.message.includes(TOKEN)
  );
});

test("constructs the Garmin API URL and bearer request without cookies", async () => {
  let call:
    | { method: string; url: string; options: Record<string, unknown> }
    | undefined;
  const client = new GarminClient({
    token: TOKEN,
    baseUrl: "https://connectapi.garmin.com/",
    requester: async (method, url, options) => {
      call = { method, url, options };
      return response(200, '{"ok":true}');
    },
  });
  assert.deepEqual(
    await client.get("sleep-service/sleep/dailySleepData?date=2026-09-13", {
      nonSleepBufferMinutes: 60,
    }),
    { ok: true }
  );
  assert.equal(call?.method, "GET");
  assert.equal(
    call?.url,
    "https://connectapi.garmin.com/sleep-service/sleep/dailySleepData?date=2026-09-13&nonSleepBufferMinutes=60"
  );
  const headers = call?.options.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal("cookie" in headers, false);
  assert.equal(call?.options.impersonate, "chrome");
});

test("uses the TLS-impersonating requester and parses JSON, empty, and binary responses", async () => {
  const calls: string[] = [];
  const client = new GarminClient({
    token: TOKEN,
    requester: async (method, url, options) => {
      calls.push(`${method} ${url} ${options.impersonate}`);
      return method === "GET" && url.endsWith("/binary")
        ? response(200, "not-json", Buffer.from([1, 2, 3]))
        : method === "GET"
          ? response(200, "")
          : response(201, '{"created":true}');
    },
  });
  assert.equal(await client.get("empty"), null);
  assert.deepEqual(await client.getBytes("binary"), Buffer.from([1, 2, 3]));
  assert.deepEqual(
    await client.request("POST", "workout-service/workout", {
      name: "test",
    }),
    { created: true }
  );
  assert.equal(
    calls.every((call) => call.endsWith(" chrome")),
    true
  );
});

test("maps Garmin failures without including response bodies or tokens", async () => {
  for (const status of [401, 403, 429, 500, 502]) {
    const client = new GarminClient({
      token: TOKEN,
      requester: async () => response(status, `secret response ${TOKEN}`),
    });
    await assert.rejects(
      client.get("metrics-service/metrics/trainingreadiness/2026-09-13"),
      (error: unknown) => {
        assert.equal(error instanceof GarminApiError, true);
        assert.equal((error as GarminApiError).status, status);
        assert.equal((error as Error).message.includes(TOKEN), false);
        assert.equal(
          (error as Error).message.includes("secret response"),
          false
        );
        return true;
      }
    );
  }
});

test("rejects non-relative paths before making a request", async () => {
  const client = new GarminClient({
    token: TOKEN,
    requester: async () => response(200),
  });
  await assert.rejects(
    client.get("https://example.com/steal"),
    /relative allowlisted/i
  );
  await assert.rejects(
    client.get("../steal"),
    /relative allowlisted|traversal/i
  );
});
