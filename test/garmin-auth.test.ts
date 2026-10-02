import assert from "node:assert/strict";
import test from "node:test";

import {
  GarminCredentialProvider,
  type GarminAuthClient,
} from "../src/garmin-auth.js";

function fakeSession(options: { refreshFails?: boolean } = {}) {
  let now = 1_000;
  let currentToken = "access-1";
  let expiresAt = 0;
  let loggedIn = false;
  let loginCount = 0;
  let refreshCount = 0;
  const auth = {
    login: async (_email: string, _password: string) => {
      loginCount++;
      currentToken = `access-login-${loginCount}`;
      expiresAt = now + 3_600;
      loggedIn = true;
    },
    is_authenticated: () => loggedIn && expiresAt > now,
    export_tokens: async () => {
      if (!loggedIn) throw new Error("no tokens");
      return {
        oauth1: { oauth_token: "oauth1", oauth_token_secret: "secret" },
        oauth2: { access_token: currentToken, expires_at: expiresAt },
      };
    },
    logout: async () => {
      loggedIn = false;
      expiresAt = 0;
    },
    restore_tokens: async () => undefined,
  };
  const client = {
    auth,
    service: {
      list: async () => {
        refreshCount++;
        if (options.refreshFails) throw new Error("refresh rejected");
        currentToken = "access-refreshed";
        expiresAt = now + 3_600;
        return [];
      },
    },
  } as unknown as GarminAuthClient;
  const provider = new GarminCredentialProvider({
    email: "owner@example.com",
    password: "private-password",
    createClient: () => client,
    now: () => now,
  });
  return {
    provider,
    expire: () => {
      now = 2_000;
      expiresAt = 1_999;
    },
    counts: () => ({ loginCount, refreshCount }),
  };
}

test("logs in on startup and refreshes expired access tokens without disk storage", async () => {
  const session = fakeSession();
  assert.equal(await session.provider.getToken(), "access-login-1");
  assert.equal(session.counts().loginCount, 1);
  session.expire();
  assert.equal(await session.provider.getToken(), "access-refreshed");
  assert.deepEqual(session.counts(), { loginCount: 1, refreshCount: 1 });
});

test("falls back to a fresh Garmin login when refresh is rejected", async () => {
  const session = fakeSession({ refreshFails: true });
  assert.equal(await session.provider.getToken(), "access-login-1");
  session.expire();
  assert.equal(await session.provider.getToken(), "access-login-2");
  assert.deepEqual(session.counts(), { loginCount: 2, refreshCount: 1 });
});

test("re-authenticates after a rejected Garmin API bearer token", async () => {
  const session = fakeSession({ refreshFails: true });
  const oldToken = await session.provider.getToken();
  assert.equal(
    await session.provider.recoverRejectedToken(oldToken),
    "access-login-2"
  );
  assert.deepEqual(session.counts(), { loginCount: 2, refreshCount: 1 });
});
