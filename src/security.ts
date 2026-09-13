import { AsyncLocalStorage } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";

export const GARMIN_READ_SCOPE = "garmin:read";
export const GARMIN_WRITE_SCOPE = "garmin:write";
export const GARMIN_SCOPES = [GARMIN_READ_SCOPE, GARMIN_WRITE_SCOPE] as const;

export type AuthConfig = {
  publicUrl: string;
  resourceUrl: string;
  metadataUrl: string;
  authToken: string;
};

export type AuthContext = {
  subject: "static-owner";
  scopes: ReadonlySet<string>;
  claims: Readonly<Record<string, never>>;
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
  return {
    publicUrl,
    resourceUrl,
    metadataUrl: `${publicUrl}/.well-known/oauth-protected-resource`,
    authToken: requireAuth
      ? required(env, "MCP_AUTH_TOKEN")
      : env.MCP_AUTH_TOKEN?.trim() || "",
  };
}

export function protectedResourceMetadata(config: AuthConfig) {
  return {
    resource: config.resourceUrl,
    authorization_servers: [config.publicUrl],
    scopes_supported: [...GARMIN_SCOPES],
    bearer_methods_supported: ["header"],
    resource_documentation: `${config.publicUrl}/`,
  };
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

export function secretMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

export async function authenticate(
  authorization: string | undefined,
  config: AuthConfig
): Promise<AuthContext> {
  const token = bearerToken(authorization);
  if (!secretMatches(token, config.authToken)) {
    throw new AuthError(401, "invalid_token", "Bearer token is invalid");
  }
  return {
    subject: "static-owner",
    scopes: new Set(GARMIN_SCOPES),
    claims: {},
  };
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

export function authChallenge(_config: AuthConfig, error?: AuthError): string {
  const parts = [`Bearer realm="garmin-coach-mcp"`];
  if (error) {
    parts.push(`error="${error.code}"`);
    parts.push(`error_description="${error.description.replaceAll('"', "'")}"`);
  }
  return parts.join(", ");
}

export function authErrorResult(error: AuthError, _config: AuthConfig) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: error.description }],
  };
}
