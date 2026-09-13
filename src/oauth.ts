import { createHash, randomBytes } from "node:crypto";

import {
  GARMIN_READ_SCOPE,
  GARMIN_SCOPES,
  GARMIN_WRITE_SCOPE,
  type AuthConfig,
  secretMatches,
} from "./security.js";

const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

type OAuthClient = {
  clientName?: string;
  redirectUris: ReadonlySet<string>;
};

type AuthorizationCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  expiresAt: number;
};

export class OAuthError extends Error {
  constructor(
    readonly status: 400 | 401,
    readonly code:
      | "invalid_request"
      | "invalid_client"
      | "invalid_grant"
      | "invalid_target"
      | "unauthorized_client"
      | "unsupported_response_type"
      | "access_denied",
    readonly description: string
  ) {
    super(description);
    this.name = "OAuthError";
  }
}

const clients = new Map<string, OAuthClient>();
const authorizationCodes = new Map<string, AuthorizationCode>();

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function requiredString(value: string | null, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new OAuthError(400, "invalid_request", `${name} is required`);
  }
  return trimmed;
}

function validRedirectUri(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" ||
        (parsed.protocol === "http:" &&
          (parsed.hostname === "localhost" ||
            parsed.hostname === "127.0.0.1" ||
            parsed.hostname === "[::1]"))) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function validCodeChallenge(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

function requestedScopes(value: string | null): string {
  const scopes = (value?.trim() || GARMIN_SCOPES.join(" "))
    .split(/\s+/)
    .filter(Boolean);
  if (
    scopes.length === 0 ||
    scopes.some(
      (scope) => scope !== GARMIN_READ_SCOPE && scope !== GARMIN_WRITE_SCOPE
    )
  ) {
    throw new OAuthError(
      400,
      "invalid_request",
      "Requested OAuth scope is not supported"
    );
  }
  return [...new Set(scopes)].join(" ");
}

function validateClient(clientId: string, redirectUri: string): void {
  const client = clients.get(clientId);
  if (!client) {
    throw new OAuthError(
      400,
      "invalid_client",
      "OAuth client is not registered"
    );
  }
  if (!client.redirectUris.has(redirectUri)) {
    throw new OAuthError(
      400,
      "invalid_request",
      "Redirect URI is not registered for this client"
    );
  }
}

export function authorizationServerMetadata(config: AuthConfig) {
  return {
    issuer: config.publicUrl,
    authorization_endpoint: `${config.publicUrl}/oauth/authorize`,
    token_endpoint: `${config.publicUrl}/oauth/token`,
    registration_endpoint: `${config.publicUrl}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...GARMIN_SCOPES],
  };
}

export function registerClient(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") {
    throw new OAuthError(
      400,
      "invalid_request",
      "Client metadata must be JSON"
    );
  }
  const record = body as Record<string, unknown>;
  const redirectUris = record.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.length > 20 ||
    redirectUris.some(
      (value): value is string =>
        typeof value !== "string" || !validRedirectUri(value)
    )
  ) {
    throw new OAuthError(
      400,
      "invalid_request",
      "One or more redirect URIs are invalid"
    );
  }
  const clientId = randomId("client");
  const clientName =
    typeof record.client_name === "string"
      ? record.client_name.slice(0, 120)
      : undefined;
  clients.set(clientId, {
    clientName,
    redirectUris: new Set(redirectUris),
  });
  return {
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  };
}

export type AuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  state: string | null;
};

export function parseAuthorizationRequest(
  params: URLSearchParams,
  config: AuthConfig
): AuthorizationRequest {
  if (params.get("response_type") !== "code") {
    throw new OAuthError(
      400,
      "unsupported_response_type",
      "Only the authorization code flow is supported"
    );
  }
  const clientId = requiredString(params.get("client_id"), "client_id");
  const redirectUri = requiredString(
    params.get("redirect_uri"),
    "redirect_uri"
  );
  if (!validRedirectUri(redirectUri)) {
    throw new OAuthError(400, "invalid_request", "Redirect URI is invalid");
  }
  validateClient(clientId, redirectUri);
  const codeChallenge = requiredString(
    params.get("code_challenge"),
    "code_challenge"
  );
  if (
    params.get("code_challenge_method") !== "S256" ||
    !validCodeChallenge(codeChallenge)
  ) {
    throw new OAuthError(
      400,
      "invalid_request",
      "PKCE S256 code challenge is required"
    );
  }
  const resource = params.get("resource")?.trim() || config.resourceUrl;
  if (resource !== config.resourceUrl) {
    throw new OAuthError(
      400,
      "invalid_target",
      "OAuth resource does not match this MCP server"
    );
  }
  return {
    clientId,
    redirectUri,
    codeChallenge,
    scope: requestedScopes(params.get("scope")),
    resource,
    state: params.get("state"),
  };
}

function htmlEscape(value: string): string {
  const escaped: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (character) => escaped[character]);
}

export function authorizationPage(request: AuthorizationRequest): string {
  const hidden = (name: string, value: string): string =>
    `<input type="hidden" name="${name}" value="${htmlEscape(value)}">`;
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Garmin Coach authorization</title>
    <style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1f2937}main{border:1px solid #d1d5db;border-radius:1rem;padding:2rem;box-shadow:0 4px 20px #0001}label{display:block;margin:.75rem 0 .35rem;font-weight:600}input{box-sizing:border-box;width:100%;padding:.7rem;border:1px solid #9ca3af;border-radius:.5rem}button{margin-top:1.5rem;width:100%;padding:.75rem;background:#2563eb;color:white;border:0;border-radius:.5rem;font-weight:700;cursor:pointer}small{color:#4b5563}</style>
  </head>
  <body><main>
    <h1>Authorize Garmin Coach</h1>
    <p>ChatGPT is requesting access to your Garmin Coach MCP server.</p>
    <p><small>Requested scopes: ${htmlEscape(request.scope)}</small></p>
    <form method="post" action="/oauth/authorize">
      ${hidden("client_id", request.clientId)}
      ${hidden("redirect_uri", request.redirectUri)}
      ${hidden("response_type", "code")}
      ${hidden("code_challenge", request.codeChallenge)}
      ${hidden("code_challenge_method", "S256")}
      ${hidden("scope", request.scope)}
      ${hidden("resource", request.resource)}
      ${request.state ? hidden("state", request.state) : ""}
      <label for="owner_token">MCP owner token</label>
      <input id="owner_token" name="owner_token" type="password" autocomplete="one-time-code" required>
      <button type="submit">Approve access</button>
    </form>
  </main></body>
</html>`;
}

export function authorize(
  params: URLSearchParams,
  ownerToken: string | null,
  config: AuthConfig
): string {
  const request = parseAuthorizationRequest(params, config);
  if (!ownerToken || !secretMatches(ownerToken, config.authToken)) {
    throw new OAuthError(
      401,
      "access_denied",
      "Owner approval was not accepted"
    );
  }
  const code = randomId("code");
  authorizationCodes.set(code, {
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    scope: request.scope,
    resource: request.resource,
    expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS,
  });
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("code", code);
  if (request.state) redirect.searchParams.set("state", request.state);
  return redirect.toString();
}

export function exchangeAuthorizationCode(
  params: URLSearchParams,
  config: AuthConfig
): Record<string, unknown> {
  if (params.get("grant_type") !== "authorization_code") {
    throw new OAuthError(
      400,
      "invalid_request",
      "Only authorization_code is supported"
    );
  }
  const clientId = requiredString(params.get("client_id"), "client_id");
  const codeValue = requiredString(params.get("code"), "code");
  const redirectUri = requiredString(
    params.get("redirect_uri"),
    "redirect_uri"
  );
  const codeVerifier = requiredString(
    params.get("code_verifier"),
    "code_verifier"
  );
  const code = authorizationCodes.get(codeValue);
  if (!code || code.expiresAt <= Date.now()) {
    authorizationCodes.delete(codeValue);
    throw new OAuthError(400, "invalid_grant", "Authorization code is invalid");
  }
  if (
    code.clientId !== clientId ||
    code.redirectUri !== redirectUri ||
    !validRedirectUri(redirectUri)
  ) {
    throw new OAuthError(400, "invalid_grant", "Authorization code is invalid");
  }
  const resource = params.get("resource")?.trim() || config.resourceUrl;
  if (resource !== code.resource || resource !== config.resourceUrl) {
    throw new OAuthError(
      400,
      "invalid_target",
      "OAuth resource does not match this MCP server"
    );
  }
  const verifierChallenge = createHash("sha256")
    .update(codeVerifier, "utf8")
    .digest("base64url");
  if (!secretMatches(verifierChallenge, code.codeChallenge)) {
    throw new OAuthError(400, "invalid_grant", "PKCE verification failed");
  }
  authorizationCodes.delete(codeValue);
  return {
    access_token: config.authToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: code.scope,
    resource: config.resourceUrl,
  };
}

export function resetOAuthStateForTests(): void {
  clients.clear();
  authorizationCodes.clear();
}
