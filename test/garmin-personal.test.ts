import assert from "node:assert/strict";
import test from "node:test";

import {
  GarminApiError,
  GarminClient,
  assertGarminConfig,
  type GarminResponse,
} from "../src/garmin-client.js";
import { parseTokenResponse, toPersonalRoute } from "../src/garmin-personal.js";

const KEY = "GCDC_test-key-that-must-never-appear";

function jwt(exp: number): string {
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ exp })}.sig`;
}

function res(status: number, text = "{}"): GarminResponse {
  return { status, text, content: Buffer.from(text) };
}

type Call = { method: string; url: string; auth: string | undefined };

function harness(
  handler: (call: Call, index: number) => GarminResponse,
  extra: ConstructorParameters<typeof GarminClient>[0] = {}
) {
  const calls: Call[] = [];
  const client = new GarminClient({
    personalApiKey: KEY,
    retryDelaysMs: [0, 0],
    sleep: async () => undefined,
    requester: async (method, url, options) => {
      const call = { method, url, auth: options.headers.Authorization };
      calls.push(call);
      return handler(call, calls.length - 1);
    },
    ...extra,
  });
  return { client, calls };
}

const TOKEN_URL =
  "https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token";

test("parses raw, quoted and JSON token responses", () => {
  const token = jwt(2_000_000_000);
  assert.equal(parseTokenResponse(token, 1).expiresAt, 2_000_000_000);
  assert.equal(parseTokenResponse(`"${token}"`, 1).token, token);
  const json = parseTokenResponse(
    JSON.stringify({ access_token: "opaque-token", expires_in: 100 }),
    50
  );
  assert.deepEqual(json, { token: "opaque-token", expiresAt: 150 });
  assert.throws(() => parseTokenResponse("two words", 1));
});

test("maps supported reads to Personal API routes and skips the rest", () => {
  assert.deepEqual(
    toPersonalRoute("sleep-service/sleep/dailySleepData", {
      date: "2026-10-24",
      nonSleepBufferMinutes: 60,
    }),
    { path: "sleep-service/sleep/dailySleep", params: { date: "2026-10-24" } }
  );
  assert.deepEqual(
    toPersonalRoute(
      "wellness-service/wellness/bodyBattery/messagingToday",
      {},
      "2026-10-24"
    ),
    {
      path: "wellness-service/wellness/bodyBattery/reports/daily",
      params: { startDate: "2026-10-24", endDate: "2026-10-24" },
    }
  );
  assert.ok(toPersonalRoute("hrv-service/hrv/2026-10-24", {}));
  assert.ok(
    toPersonalRoute("activitylist-service/activities/search/activities", {
      start: 0,
      limit: 10,
    })
  );
  for (const path of [
    "metrics-service/metrics/trainingreadiness/2026-10-24",
    "workout-service/workouts",
    "calendar-service/year/2026/month/9",
    "userprofile-service/userprofile/user-settings/",
  ]) {
    assert.equal(toPersonalRoute(path, {}), undefined, path);
  }
});

test("reads use the key-derived bearer token, cached across calls", async () => {
  const { client, calls } = harness((call) =>
    call.method === "POST" ? res(200, jwt(4_000_000_000)) : res(200, '{"ok":1}')
  );
  assert.deepEqual(await client.get("hrv-service/hrv/2026-10-24"), { ok: 1 });
  await client.get("wellness-service/wellness/dailyHeartRate", {
    date: "2026-10-24",
  });
  const exchanges = calls.filter((call) => call.method === "POST");
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].url, TOKEN_URL);
  assert.equal(exchanges[0].auth, `ApiKey ${KEY}`);
  const reads = calls.filter((call) => call.method === "GET");
  assert.ok(
    reads.every((call) =>
      call.url.startsWith("https://personal.connectapi.garmin.com/")
    )
  );
  assert.ok(
    reads.every((call) => call.auth === `Bearer ${jwt(4_000_000_000)}`)
  );
});

test("re-exchanges once on 401 and retries 429 with backoff", async () => {
  let tokens = 0;
  let reads = 0;
  const { client } = harness((call) => {
    if (call.method === "POST") return res(200, jwt(4_000_000_000 + ++tokens));
    reads += 1;
    if (reads === 1) return res(401);
    if (reads === 2) return res(429);
    return res(200, "[1]");
  });
  assert.deepEqual(await client.get("hrv-service/hrv/2026-10-24"), [1]);
  assert.equal(tokens, 2);
});

test("persistent 429 surfaces a rate-limit error without touching SSO", async () => {
  const { client, calls } = harness((call) =>
    call.method === "POST" ? res(200, jwt(4_000_000_000)) : res(429)
  );
  await assert.rejects(
    client.get("hrv-service/hrv/2026-10-24"),
    (error: unknown) =>
      error instanceof GarminApiError &&
      error.status === 429 &&
      !error.message.includes(KEY)
  );
  assert.equal(calls.filter((call) => call.method === "GET").length, 3);
});

test("unsupported routes explain the read-only limit when SSO is not configured", async () => {
  const saved = [process.env.GARMIN_EMAIL, process.env.GARMIN_PASSWORD];
  delete process.env.GARMIN_EMAIL;
  delete process.env.GARMIN_PASSWORD;
  try {
    const { client } = harness(() => res(200, jwt(4_000_000_000)));
    await assert.rejects(
      client.get("workout-service/workouts"),
      /Personal API key/
    );
    await assert.rejects(
      client.request("POST", "workout-service/workout", {}),
      /Personal API key/
    );
    await client.close();
  } finally {
    [process.env.GARMIN_EMAIL, process.env.GARMIN_PASSWORD] = saved;
  }
});

test("key rejection is reported without leaking the key", async () => {
  const saved = [process.env.GARMIN_EMAIL, process.env.GARMIN_PASSWORD];
  delete process.env.GARMIN_EMAIL;
  delete process.env.GARMIN_PASSWORD;
  try {
    const { client } = harness(() => res(401));
    await assert.rejects(
      client.get("hrv-service/hrv/2026-10-24"),
      (error: unknown) =>
        error instanceof Error &&
        /key was rejected/.test(error.message) &&
        !error.message.includes(KEY)
    );
  } finally {
    [process.env.GARMIN_EMAIL, process.env.GARMIN_PASSWORD] = saved;
  }
});

test("personal key alone satisfies config validation", () => {
  assert.doesNotThrow(() =>
    assertGarminConfig({
      GARMIN_PERSONAL_API_KEY: KEY,
      GARMIN_API_BASE_URL: "https://connectapi.garmin.com",
    })
  );
  assert.throws(
    () =>
      assertGarminConfig({
        GARMIN_PERSONAL_API_KEY: KEY,
        GARMIN_PERSONAL_API_BASE_URL: "http://insecure.example",
      }),
    /GARMIN_PERSONAL_API_BASE_URL/
  );
});
