import assert from "node:assert/strict";
import test from "node:test";

import { closeHttpServer, startHttpServer } from "../src/http.js";

test("health and OAuth discovery are public while /mcp requires bearer auth", async () => {
  const previous = {
    GARMIN_TOKEN: process.env.GARMIN_TOKEN,
    GARMIN_API_BASE_URL: process.env.GARMIN_API_BASE_URL,
    AUTH0_ISSUER: process.env.AUTH0_ISSUER,
    AUTH0_AUDIENCE: process.env.AUTH0_AUDIENCE,
    AUTH0_ALLOWED_SUBJECT: process.env.AUTH0_ALLOWED_SUBJECT,
    MCP_PUBLIC_URL: process.env.MCP_PUBLIC_URL,
    MCP_RESOURCE_URL: process.env.MCP_RESOURCE_URL,
    MCP_BIND_HOST: process.env.MCP_BIND_HOST,
    MCP_ALLOWED_ORIGINS: process.env.MCP_ALLOWED_ORIGINS,
    PORT: process.env.PORT,
  };
  Object.assign(process.env, {
    GARMIN_TOKEN: "test-token",
    GARMIN_API_BASE_URL: "https://connectapi.garmin.com",
    AUTH0_ISSUER: "https://tenant.auth0.com/",
    AUTH0_AUDIENCE: "http://127.0.0.1:38765/mcp",
    AUTH0_ALLOWED_SUBJECT: "auth0|owner",
    MCP_PUBLIC_URL: "http://127.0.0.1:38765",
    MCP_RESOURCE_URL: "http://127.0.0.1:38765/mcp",
    MCP_BIND_HOST: "127.0.0.1",
    MCP_ALLOWED_ORIGINS: "http://localhost:6274,http://127.0.0.1:6274",
    PORT: "38765",
  });
  try {
    await startHttpServer();
    const health = await fetch("http://127.0.0.1:38765/healthz");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    const discovery = await fetch(
      "http://127.0.0.1:38765/.well-known/oauth-protected-resource"
    );
    assert.equal(discovery.status, 200);
    assert.deepEqual((await discovery.json()).scopes_supported, [
      "garmin:read",
      "garmin:write",
    ]);
    const mcp = await fetch("http://127.0.0.1:38765/mcp", {
      method: "POST",
      body: "{}",
    });
    assert.equal(mcp.status, 401);
    assert.match(
      mcp.headers.get("www-authenticate") || "",
      /resource_metadata/
    );
    const invalidOrigin = await fetch("http://127.0.0.1:38765/mcp", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
      body: "{}",
    });
    assert.equal(invalidOrigin.status, 403);
  } finally {
    await closeHttpServer();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
});
