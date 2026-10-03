import assert from "node:assert/strict";
import test from "node:test";

import {
  createGarminSsoFetch,
  GarminCredentialProvider,
  GarminSsoRateLimitError,
  type GarminAuthClient,
  type GarminSsoSession,
} from "../src/garmin-auth.js";

test("uses the impersonating SSO session and form body without exposing secrets", async () => {
  let request:
    | { method: string; url: string; options: Record<string, unknown> }
    | undefined;
  const session = {
    request: async (
      method: string,
      url: string,
      options: Record<string, unknown>
    ) => {
      request = { method, url, options };
      return {
        content: Buffer.from("ok"),
        status: 200,
        statusText: "OK",
        headers: { toObject: () => ({ "content-type": "text/html" }) },
      };
    },
    close: async () => undefined,
  } as unknown as GarminSsoSession;
  const fetch = createGarminSsoFetch(session);
  const response = await fetch("https://sso.garmin.com/sso/signin", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: "owner@example.com",
      password: "private-password",
    }),
  });
  assert.equal(await response.text(), "ok");
  assert.equal(request?.method, "POST");
  assert.equal(request?.url, "https://sso.garmin.com/sso/signin");
  assert.equal(request?.options.impersonate, "chrome");
  assert.equal(
    request?.options.content,
    "username=owner%40example.com&password=private-password"
  );
});

test("surfaces Garmin SSO 429 responses with the Retry-After cooldown", async () => {
  const session = {
    request: async () => ({
      content: Buffer.from("private response body"),
      status: 429,
      statusText: "Too Many Requests",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "retry-after" ? "120" : null,
        toObject: () => ({ "retry-after": "120" }),
      },
    }),
    close: async () => undefined,
  } as unknown as GarminSsoSession;

  await assert.rejects(
    createGarminSsoFetch(session)("https://sso.garmin.com/sso/signin"),
    (error: unknown) => {
      const rateLimitError = error as Error & { retryAfterMs?: number };
      return (
        /rate limit/i.test(rateLimitError.message) &&
        rateLimitError.retryAfterMs === 120_000
      );
    }
  );
});

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
    restore_tokens: async (tokens: unknown) => {
      const restored = tokens as {
        oauth2: { access_token: string; expires_at: number };
      };
      currentToken = restored.oauth2.access_token;
      expiresAt = restored.oauth2.expires_at;
      loggedIn = true;
    },
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
    providerWithTokens: (tokens: string) =>
      new GarminCredentialProvider({
        email: "owner@example.com",
        password: "private-password",
        tokens,
        createClient: () => client,
        now: () => now,
      }),
    expire: () => {
      now = 2_000;
      expiresAt = 1_999;
    },
    counts: () => ({ loginCount, refreshCount }),
  };
}

test("restores a seeded OAuth session before attempting password SSO", async () => {
  const session = fakeSession();
  const provider = session.providerWithTokens(
    JSON.stringify({
      oauth1: { oauth_token: "oauth1", oauth_token_secret: "secret" },
      oauth2: { access_token: "seeded-access", expires_at: 2_000 },
    })
  );

  assert.equal(await provider.getToken(), "seeded-access");
  assert.equal(session.counts().loginCount, 0);
});

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

test("shares one failed login across concurrent Garmin reads", async () => {
  let loginCount = 0;
  const client = {
    auth: {
      is_authenticated: () => false,
      export_tokens: async () => {
        throw new Error("no tokens");
      },
      logout: async () => undefined,
      login: async () => {
        loginCount++;
        throw new Error("simulated Garmin SSO 429");
      },
    },
    service: { list: async () => [] },
  } as unknown as GarminAuthClient;
  const provider = new GarminCredentialProvider({
    email: "owner@example.com",
    password: "private-password",
    createClient: () => client,
  });

  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => provider.getToken())
  );

  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    8
  );
  assert.equal(loginCount, 1);
});

test("waits for Retry-After before attempting Garmin SSO again", async () => {
  let nowMilliseconds = 1_000;
  let loginCount = 0;
  let loggedIn = false;
  const client = {
    auth: {
      is_authenticated: () => loggedIn,
      export_tokens: async () => {
        if (!loggedIn) throw new Error("no tokens");
        return {
          oauth1: { oauth_token: "oauth1", oauth_token_secret: "secret" },
          oauth2: {
            access_token: "access-ready",
            expires_at: Math.floor(nowMilliseconds / 1_000) + 3_600,
          },
        };
      },
      logout: async () => {
        loggedIn = false;
      },
      login: async () => {
        loginCount++;
        if (loginCount === 1) throw new GarminSsoRateLimitError(60_000);
        loggedIn = true;
      },
    },
    service: { list: async () => [] },
  } as unknown as GarminAuthClient;
  const provider = new GarminCredentialProvider({
    email: "owner@example.com",
    password: "private-password",
    createClient: () => client,
    now: () => Math.floor(nowMilliseconds / 1_000),
    nowMilliseconds: () => nowMilliseconds,
  });

  await assert.rejects(provider.getToken(), GarminSsoRateLimitError);
  await assert.rejects(provider.getToken(), GarminSsoRateLimitError);
  assert.equal(loginCount, 1);

  nowMilliseconds += 60_000;
  assert.equal(await provider.getToken(), "access-ready");
  assert.equal(loginCount, 2);
});

test("uses a bounded fallback cooldown when Garmin omits Retry-After", async () => {
  let nowMilliseconds = 0;
  let loginCount = 0;
  let loggedIn = false;
  const client = {
    auth: {
      is_authenticated: () => loggedIn,
      export_tokens: async () => {
        if (!loggedIn) throw new Error("no tokens");
        return {
          oauth1: { oauth_token: "oauth1", oauth_token_secret: "secret" },
          oauth2: {
            access_token: "access-ready",
            expires_at: Math.floor(nowMilliseconds / 1_000) + 3_600,
          },
        };
      },
      logout: async () => {
        loggedIn = false;
      },
      login: async () => {
        loginCount++;
        if (loginCount === 1) throw new GarminSsoRateLimitError();
        loggedIn = true;
      },
    },
    service: { list: async () => [] },
  } as unknown as GarminAuthClient;
  const provider = new GarminCredentialProvider({
    email: "owner@example.com",
    password: "private-password",
    createClient: () => client,
    now: () => Math.floor(nowMilliseconds / 1_000),
    nowMilliseconds: () => nowMilliseconds,
  });

  await assert.rejects(provider.getToken(), GarminSsoRateLimitError);
  const cooldownError = await provider.getToken().then(
    () => undefined,
    (error: unknown) => error
  );
  assert.ok(cooldownError instanceof GarminSsoRateLimitError);
  assert.match(cooldownError.message, /retry after 900 seconds/);
  assert.equal(loginCount, 1);

  nowMilliseconds += 15 * 60 * 1_000;
  assert.equal(await provider.getToken(), "access-ready");
  assert.equal(loginCount, 2);
});
