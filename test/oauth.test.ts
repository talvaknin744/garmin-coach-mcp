import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  authorizationPage,
  authorizationServerMetadata,
  authorize,
  exchangeAuthorizationCode,
  parseAuthorizationRequest,
  registerClient,
  resetOAuthStateForTests,
} from "../src/oauth.js";
import { getAuthConfig } from "../src/security.js";

const TOKEN = "static-oauth-test-token";
const CONFIG = getAuthConfig(
  {
    MCP_PUBLIC_URL: "https://garmin.example",
    MCP_RESOURCE_URL: "https://garmin.example/mcp",
    MCP_AUTH_TOKEN: TOKEN,
  },
  true
);

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

test("publishes self-hosted OAuth metadata and completes PKCE with static owner approval", () => {
  resetOAuthStateForTests();
  const redirectUri = "https://chat.example/callback";
  const registration = registerClient({
    client_name: "ChatGPT",
    redirect_uris: [redirectUri],
  });
  const clientId = String(registration.client_id);
  const verifier = "a".repeat(43);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge(verifier),
    code_challenge_method: "S256",
    scope: "garmin:read garmin:write",
    resource: CONFIG.resourceUrl,
    state: "state-value",
  });
  const authorizationRequest = parseAuthorizationRequest(params, CONFIG);
  const page = authorizationPage(authorizationRequest);
  assert.match(page, /Approve access/);
  assert.equal(page.includes(TOKEN), false);
  const redirect = authorize(params, TOKEN, CONFIG);
  const callback = new URL(redirect);
  const code = callback.searchParams.get("code");
  assert.ok(code);
  assert.equal(callback.searchParams.get("state"), "state-value");

  const token = exchangeAuthorizationCode(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
      resource: CONFIG.resourceUrl,
    }),
    CONFIG
  );
  assert.equal(token.access_token, TOKEN);
  assert.equal(token.token_type, "Bearer");
  assert.equal(token.scope, "garmin:read garmin:write");
  assert.throws(
    () =>
      exchangeAuthorizationCode(
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          redirect_uri: redirectUri,
          code,
          code_verifier: verifier,
          resource: CONFIG.resourceUrl,
        }),
        CONFIG
      ),
    /Authorization code is invalid/
  );
  assert.deepEqual(authorizationServerMetadata(CONFIG), {
    issuer: "https://garmin.example",
    authorization_endpoint: "https://garmin.example/oauth/authorize",
    token_endpoint: "https://garmin.example/oauth/token",
    registration_endpoint: "https://garmin.example/oauth/register",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["garmin:read", "garmin:write"],
  });
});

test("rejects wrong owner approval and non-PKCE authorization", () => {
  resetOAuthStateForTests();
  const redirectUri = "https://chat.example/callback";
  const registration = registerClient({ redirect_uris: [redirectUri] });
  const params = new URLSearchParams({
    response_type: "code",
    client_id: String(registration.client_id),
    redirect_uri: redirectUri,
    code_challenge: "b".repeat(43),
    code_challenge_method: "S256",
    resource: CONFIG.resourceUrl,
  });
  assert.throws(
    () => authorize(params, "wrong-token", CONFIG),
    /Owner approval/
  );
  params.set("code_challenge_method", "plain");
  assert.throws(() => parseAuthorizationRequest(params, CONFIG), /PKCE S256/);
});
