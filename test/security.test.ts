import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticate,
  authChallenge,
  AuthError,
  getAuthConfig,
  protectedResourceMetadata,
  requireScope,
  runWithAuthContext,
} from "../src/security.js";

const TOKEN = "static-test-token-that-must-never-appear-in-errors";

test("builds static bearer configuration without Auth0 settings", () => {
  const config = getAuthConfig(
    {
      MCP_PUBLIC_URL: "https://garmin.example",
      MCP_RESOURCE_URL: "https://garmin.example/mcp",
      MCP_AUTH_TOKEN: TOKEN,
    },
    true
  );
  assert.deepEqual(protectedResourceMetadata(config), {
    resource: "https://garmin.example/mcp",
    authorization_servers: ["https://garmin.example"],
    scopes_supported: ["garmin:read", "garmin:write"],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://garmin.example/",
  });
  assert.match(authChallenge(config), /Bearer realm="garmin-coach-mcp"/);
  assert.equal(authChallenge(config).includes(TOKEN), false);
});

test("requires MCP_AUTH_TOKEN at runtime", () => {
  assert.throws(
    () =>
      getAuthConfig(
        {
          MCP_PUBLIC_URL: "http://127.0.0.1:8788",
          MCP_RESOURCE_URL: "http://127.0.0.1:8788/mcp",
        },
        true
      ),
    /MCP_AUTH_TOKEN/
  );
});

test("accepts only the exact static bearer and grants both internal scopes", async () => {
  const config = getAuthConfig(
    {
      MCP_PUBLIC_URL: "http://127.0.0.1:8788",
      MCP_RESOURCE_URL: "http://127.0.0.1:8788/mcp",
      MCP_AUTH_TOKEN: TOKEN,
    },
    true
  );
  const valid = await authenticate(`Bearer ${TOKEN}`, config);
  assert.equal(valid.subject, "static-owner");
  assert.equal(valid.scopes.has("garmin:read"), true);
  assert.equal(valid.scopes.has("garmin:write"), true);
  assert.doesNotThrow(() =>
    runWithAuthContext(valid, () => {
      requireScope("garmin:read");
      requireScope("garmin:write");
    })
  );
  await assert.rejects(
    authenticate(undefined, config),
    (error: unknown) => error instanceof AuthError && error.status === 401
  );
  await assert.rejects(
    authenticate(`Bearer wrong-${TOKEN}`, config),
    (error: unknown) =>
      error instanceof AuthError &&
      error.status === 401 &&
      !error.message.includes(TOKEN)
  );
  await assert.rejects(
    authenticate(`Basic ${TOKEN}`, config),
    (error: unknown) => error instanceof AuthError && error.status === 401
  );
});
