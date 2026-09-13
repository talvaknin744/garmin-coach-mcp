import { generateKeyPairSync } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import assert from "node:assert/strict";
import test from "node:test";

import { exportJWK, SignJWT } from "jose";

import {
  authenticate,
  authChallenge,
  AuthError,
  getAuthConfig,
  protectedResourceMetadata,
  requireScope,
  runWithAuthContext,
} from "../src/security.js";

test("builds protected-resource metadata and owner-only OAuth configuration", () => {
  const config = getAuthConfig(
    {
      MCP_PUBLIC_URL: "https://garmin.example",
      MCP_RESOURCE_URL: "https://garmin.example/mcp",
      AUTH0_ISSUER: "https://tenant.auth0.com/",
      AUTH0_AUDIENCE: "https://garmin.example/mcp",
      AUTH0_ALLOWED_SUBJECT: "auth0|owner",
    },
    true
  );
  assert.deepEqual(protectedResourceMetadata(config), {
    resource: "https://garmin.example/mcp",
    authorization_servers: ["https://tenant.auth0.com/"],
    scopes_supported: ["garmin:read", "garmin:write"],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://garmin.example/",
  });
  assert.match(
    authChallenge(config),
    /resource_metadata="https:\/\/garmin.example/
  );
});

test("validates Auth0 signature, issuer, audience, expiration, subject, and scope", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = await exportJWK(publicKey);
  let jwksServer: Server | undefined;
  const issuerBase = await new Promise<string>((resolve, reject) => {
    const server = createHttpServer((request, response) => {
      if (request.url === "/.well-known/jwks.json") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            keys: [{ ...jwk, kid: "test", alg: "RS256", use: "sig" }],
          })
        );
        return;
      }
      response.writeHead(404).end();
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("No test port"));
      jwksServer = server;
      resolve(`http://127.0.0.1:${address.port}/`);
    });
  });
  const config = {
    publicUrl: "http://127.0.0.1",
    resourceUrl: "http://127.0.0.1/mcp",
    metadataUrl: "http://127.0.0.1/.well-known/oauth-protected-resource",
    issuer: issuerBase,
    audience: "http://127.0.0.1/mcp",
    allowedSubject: "auth0|owner",
  };
  const sign = async (
    subject = config.allowedSubject,
    issuer = config.issuer,
    audience = config.audience,
    expiration = "1h"
  ) =>
    new SignJWT({ scope: "garmin:read" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(subject)
      .setExpirationTime(expiration)
      .sign(privateKey);

  try {
    const valid = await authenticate(`Bearer ${await sign()}`, config);
    assert.equal(valid.subject, config.allowedSubject);
    assert.equal(valid.scopes.has("garmin:read"), true);
    assert.throws(
      () => runWithAuthContext(valid, () => requireScope("garmin:write")),
      (error: unknown) =>
        error instanceof AuthError &&
        error.status === 403 &&
        error.code === "insufficient_scope"
    );
    await assert.rejects(
      authenticate(undefined, config),
      (error: unknown) => error instanceof AuthError && error.status === 401
    );
    await assert.rejects(
      authenticate(`Bearer ${await sign("auth0|other")}`, config),
      (error: unknown) => error instanceof AuthError && error.status === 403
    );
    await assert.rejects(
      authenticate(
        `Bearer ${await sign(config.allowedSubject, "https://wrong.example/")}`,
        config
      ),
      /invalid|expired/i
    );
    await assert.rejects(
      authenticate(
        `Bearer ${await sign(
          config.allowedSubject,
          config.issuer,
          "https://wrong.example/mcp"
        )}`,
        config
      ),
      /invalid|expired/i
    );
    await assert.rejects(
      authenticate(
        `Bearer ${await sign(
          config.allowedSubject,
          config.issuer,
          config.audience,
          "0s"
        )}`,
        config
      ),
      /invalid|expired/i
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      if (!jwksServer) {
        resolve();
        return;
      }
      jwksServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
