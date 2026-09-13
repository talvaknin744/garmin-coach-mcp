import { AsyncLocalStorage } from "node:async_hooks";

import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

export const GARMIN_READ_SCOPE = "garmin:read";
export const GARMIN_WRITE_SCOPE = "garmin:write";
export const GARMIN_SCOPES = [GARMIN_READ_SCOPE, GARMIN_WRITE_SCOPE] as const;

export type AuthConfig = {
  publicUrl: string;
  resourceUrl: string;
  metadataUrl: string;
  issuer: string;
  audience: string;
  allowedSubject: string;
};

export type AuthContext = {
  subject: string;
  scopes: ReadonlySet<string>;
  claims: JWTPayload;
};

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: "invalid_token" | "access_denied" | "insufficient_scope",
    readonly description: string
  ) {
    super(description);
    this.name = "AuthError";
  }
}

const authStorage = new AsyncLocalStorage<AuthContext>();
let jwks: { issuer: string; url: URL; getKey: JWTVerifyGetKey } | null = null;

function required(
  env: NodeJS.ProcessEnv,
  name: keyof NodeJS.ProcessEnv
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function urlValue(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }
  return parsed.toString().replace(/\/+$/, "");
}

function issuerValue(value: string): string {
  const normalized = urlValue(value, "AUTH0_ISSUER");
  return `${normalized}/`;
}

export function getAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  requireAuth = true
): AuthConfig {
  const publicUrl = urlValue(
    env.MCP_PUBLIC_URL?.trim() ||
      env.RENDER_EXTERNAL_URL?.trim() ||
      `http://localhost:${env.PORT?.trim() || "8788"}`,
    "MCP_PUBLIC_URL"
  );
  if (
    requireAuth &&
    (env.RENDER || env.NODE_ENV === "production") &&
    !publicUrl.startsWith("https://")
  ) {
    throw new Error("MCP_PUBLIC_URL must use HTTPS in production");
  }
  const resourceUrl = urlValue(
    env.MCP_RESOURCE_URL?.trim() || `${publicUrl}/mcp`,
    "MCP_RESOURCE_URL"
  );
  if (
    requireAuth &&
    (env.RENDER || env.NODE_ENV === "production") &&
    !resourceUrl.startsWith("https://")
  ) {
    throw new Error("MCP_RESOURCE_URL must use HTTPS in production");
  }
  if (requireAuth) {
    const issuer = issuerValue(required(env, "AUTH0_ISSUER"));
    const allowedSubject = required(env, "AUTH0_ALLOWED_SUBJECT");
    const audience = urlValue(
      env.AUTH0_AUDIENCE?.trim() || resourceUrl,
      "AUTH0_AUDIENCE"
    );
    if (audience !== resourceUrl) {
      throw new Error("AUTH0_AUDIENCE must exactly equal MCP_RESOURCE_URL");
    }
    return {
      publicUrl,
      resourceUrl,
      metadataUrl: `${publicUrl}/.well-known/oauth-protected-resource`,
      issuer,
      audience,
      allowedSubject,
    };
  }
  return {
    publicUrl,
    resourceUrl,
    metadataUrl: `${publicUrl}/.well-known/oauth-protected-resource`,
    issuer: env.AUTH0_ISSUER?.trim() ? issuerValue(env.AUTH0_ISSUER) : "",
    audience: env.AUTH0_AUDIENCE?.trim() || resourceUrl,
    allowedSubject: env.AUTH0_ALLOWED_SUBJECT?.trim() || "",
  };
}

export function protectedResourceMetadata(config: AuthConfig) {
  return {
    resource: config.resourceUrl,
    authorization_servers: [config.issuer],
    scopes_supported: [...GARMIN_SCOPES],
    bearer_methods_supported: ["header"],
    resource_documentation: `${config.publicUrl}/`,
  };
}

function scopeSet(payload: JWTPayload): Set<string> {
  const value = payload.scope;
  if (typeof value === "string") {
    return new Set(value.split(/\s+/).filter(Boolean));
  }
  if (Array.isArray(value)) {
    return new Set(
      value.filter((item): item is string => typeof item === "string")
    );
  }
  return new Set();
}

function bearerToken(header: string | undefined): string {
  if (!header) {
    throw new AuthError(
      401,
      "invalid_token",
      "Bearer authentication is required"
    );
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) {
    throw new AuthError(
      401,
      "invalid_token",
      "Bearer authentication is required"
    );
  }
  return match[1];
}

function keyFor(config: AuthConfig): JWTVerifyGetKey {
  if (!jwks || jwks.issuer !== config.issuer) {
    const url = new URL(".well-known/jwks.json", config.issuer);
    jwks = { issuer: config.issuer, url, getKey: createRemoteJWKSet(url) };
  }
  return jwks.getKey;
}

export async function authenticate(
  authorization: string | undefined,
  config: AuthConfig
): Promise<AuthContext> {
  const token = bearerToken(authorization);
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keyFor(config), {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ["RS256"],
    }));
  } catch {
    throw new AuthError(
      401,
      "invalid_token",
      "Bearer token is invalid or expired"
    );
  }
  if (
    typeof payload.sub !== "string" ||
    payload.sub !== config.allowedSubject
  ) {
    throw new AuthError(
      403,
      "access_denied",
      "This Garmin MCP is restricted to its owner"
    );
  }
  return { subject: payload.sub, scopes: scopeSet(payload), claims: payload };
}

export function runWithAuthContext<T>(
  context: AuthContext,
  action: () => T
): T {
  return authStorage.run(context, action);
}

export function currentAuthContext(): AuthContext | undefined {
  return authStorage.getStore();
}

export function requireScope(scope: string): void {
  const context = currentAuthContext();
  // stdio is intentionally local and has no bearer token context.
  if (!context) return;
  if (!context.scopes.has(scope)) {
    throw new AuthError(
      403,
      "insufficient_scope",
      `Bearer token lacks required scope: ${scope}`
    );
  }
}

export function authChallenge(config: AuthConfig, error?: AuthError): string {
  const parts = [`Bearer resource_metadata="${config.metadataUrl}"`];
  if (error) {
    parts.push(`error="${error.code}"`);
    parts.push(`error_description="${error.description.replaceAll('"', "'")}"`);
  }
  return parts.join(", ");
}

export function authErrorResult(error: AuthError, config: AuthConfig) {
  const challenge = authChallenge(config, error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: error.description }],
    _meta: { "mcp/www_authenticate": [challenge] },
  };
}
