import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { assertGarminConfig } from "./garmin-client.js";
import { createMcpServer } from "./mcp-server.js";
import {
  authorize,
  authorizationPage,
  authorizationServerMetadata,
  exchangeAuthorizationCode,
  OAuthError,
  parseAuthorizationRequest,
  registerClient,
} from "./oauth.js";
import { errorMessage } from "./safety.js";
import {
  authenticate,
  authChallenge,
  authErrorResult,
  getAuthConfig,
  protectedResourceMetadata,
  runWithAuthContext,
  type AuthConfig,
  type AuthContext,
  AuthError,
} from "./security.js";

const MAX_BODY_BYTES = 1_048_576;
const MCP_PATH = "/mcp";
const HEALTH_PATH = "/healthz";
const DISCOVERY_PATH = "/.well-known/oauth-protected-resource";
const AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";
const AUTHORIZE_PATH = "/oauth/authorize";
const TOKEN_PATH = "/oauth/token";
const REGISTER_PATH = "/oauth/register";
const DEFAULT_LOCAL_ORIGINS = new Set([
  "http://localhost:6274",
  "http://127.0.0.1:6274",
]);

type Session = {
  server: ReturnType<typeof createMcpServer>;
  transport: StreamableHTTPServerTransport;
  subject: string;
};

const sessions = new Map<string, Session>();
let httpServer: Server | null = null;

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function configuredOrigins(): Set<string> {
  const configured = process.env.MCP_ALLOWED_ORIGINS?.trim();
  if (!configured) return DEFAULT_LOCAL_ORIGINS;
  const origins = new Set<string>();
  for (const value of configured.split(",")) {
    const origin = value.trim();
    if (!origin) continue;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("MCP_ALLOWED_ORIGINS must contain valid origins");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("MCP_ALLOWED_ORIGINS must contain origin URLs only");
    }
    origins.add(parsed.origin);
  }
  return origins;
}

function originAllowed(request: IncomingMessage): boolean {
  const origin = headerValue(request.headers.origin);
  if (!origin) return true;
  return configuredOrigins().has(origin);
}

function bindHost(): string {
  const configured = process.env.MCP_BIND_HOST?.trim();
  if (configured) return configured;
  return process.env.RENDER || process.env.NODE_ENV === "production"
    ? "0.0.0.0"
    : "127.0.0.1";
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {}
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(body);
}

function sendText(
  response: ServerResponse,
  status: number,
  text: string,
  headers: Record<string, string> = {}
): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(text);
}

function sendHtml(
  response: ServerResponse,
  status: number,
  html: string,
  headers: Record<string, string> = {}
): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(html);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("MCP request body is too large");
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("MCP request body must be valid JSON");
  }
}

async function readFormBody(
  request: IncomingMessage
): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES)
      throw new Error("OAuth request body is too large");
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function oauthErrorResponse(response: ServerResponse, error: OAuthError): void {
  sendJson(response, error.status, {
    error: error.code,
    error_description: error.description,
  });
}

function sessionId(request: IncomingMessage): string | undefined {
  return headerValue(request.headers["mcp-session-id"]);
}

function isInitialize(body: unknown): boolean {
  return Boolean(
    body &&
    typeof body === "object" &&
    (body as Record<string, unknown>).method === "initialize"
  );
}

function authResponse(
  error: AuthError,
  response: ServerResponse,
  config: AuthConfig
): void {
  const challenge = authChallenge(config, error);
  sendJson(response, error.status, authErrorResult(error, config), {
    "www-authenticate": challenge,
  });
}

async function protectedRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: AuthConfig
): Promise<AuthContext | null> {
  try {
    return await authenticate(
      headerValue(request.headers.authorization),
      config
    );
  } catch (error) {
    if (error instanceof AuthError) authResponse(error, response, config);
    else sendJson(response, 401, { error: "invalid_token" });
    return null;
  }
}

async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: AuthContext
): Promise<void> {
  const id = sessionId(request);
  const existing = id ? sessions.get(id) : undefined;
  if (id && !existing) {
    sendText(response, 404, "MCP session not found");
    return;
  }
  if (existing && existing.subject !== context.subject) {
    sendText(response, 403, "MCP session belongs to another owner");
    return;
  }
  if (request.method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendText(
        response,
        400,
        error instanceof Error ? error.message : "Invalid MCP body"
      );
      return;
    }
    if (existing) {
      await existing.transport.handleRequest(request, response, body);
      return;
    }
    if (!isInitialize(body)) {
      sendText(
        response,
        400,
        "An MCP initialize request is required to create a session"
      );
      return;
    }
    const server = createMcpServer();
    let createdSessionId: string | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        createdSessionId = newSessionId;
        sessions.set(newSessionId, {
          server,
          transport,
          subject: context.subject,
        });
      },
    });
    transport.onclose = () => {
      if (createdSessionId) sessions.delete(createdSessionId);
      void server.close();
    };
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
    return;
  }
  if (!existing) {
    sendText(response, 400, "MCP session ID is required");
    return;
  }
  await existing.transport.handleRequest(request, response);
}

async function requestHandler(
  request: IncomingMessage,
  response: ServerResponse,
  config: AuthConfig
): Promise<void> {
  const url = new URL(request.url || "/", "http://localhost");
  if (url.pathname === HEALTH_PATH && request.method === "GET") {
    sendJson(response, 200, { status: "ok" });
    return;
  }
  if (url.pathname === DISCOVERY_PATH && request.method === "GET") {
    sendJson(response, 200, protectedResourceMetadata(config));
    return;
  }
  if (url.pathname === AUTHORIZATION_SERVER_PATH && request.method === "GET") {
    sendJson(response, 200, authorizationServerMetadata(config));
    return;
  }
  if (url.pathname === REGISTER_PATH && request.method === "POST") {
    try {
      sendJson(response, 201, registerClient(await readJsonBody(request)));
    } catch (error) {
      if (error instanceof OAuthError) oauthErrorResponse(response, error);
      else sendJson(response, 400, { error: "invalid_request" });
    }
    return;
  }
  if (url.pathname === AUTHORIZE_PATH) {
    try {
      if (request.method === "GET") {
        const authorizationRequest = parseAuthorizationRequest(
          url.searchParams,
          config
        );
        sendHtml(response, 200, authorizationPage(authorizationRequest));
      } else if (request.method === "POST") {
        const params = await readFormBody(request);
        const redirect = authorize(params, params.get("owner_token"), config);
        response.writeHead(302, {
          location: redirect,
          "cache-control": "no-store",
        });
        response.end();
      } else {
        sendText(response, 405, "Method not allowed", { allow: "GET, POST" });
      }
    } catch (error) {
      if (error instanceof OAuthError) oauthErrorResponse(response, error);
      else sendJson(response, 400, { error: "invalid_request" });
    }
    return;
  }
  if (url.pathname === TOKEN_PATH && request.method === "POST") {
    try {
      sendJson(
        response,
        200,
        exchangeAuthorizationCode(await readFormBody(request), config)
      );
    } catch (error) {
      if (error instanceof OAuthError) oauthErrorResponse(response, error);
      else sendJson(response, 400, { error: "invalid_request" });
    }
    return;
  }
  if (url.pathname !== MCP_PATH) {
    sendText(response, 404, "Not found");
    return;
  }
  if (!["GET", "POST", "DELETE"].includes(request.method || "")) {
    sendText(response, 405, "Method not allowed", {
      allow: "GET, POST, DELETE",
    });
    return;
  }
  if (!originAllowed(request)) {
    sendText(response, 403, "Invalid request origin");
    return;
  }
  const context = await protectedRequest(request, response, config);
  if (!context) return;
  await runWithAuthContext(context, () =>
    handleMcpRequest(request, response, context)
  );
}

export async function startHttpServer(): Promise<void> {
  assertGarminConfig();
  const config = getAuthConfig();
  const port = Number(process.env.PORT || 8788);
  if (!Number.isInteger(port) || port <= 0 || port > 65535)
    throw new Error("PORT must be a valid TCP port");
  const host = bindHost();
  httpServer = createServer((request, response) => {
    void requestHandler(request, response, config).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, 500, { error: "internal_server_error" });
      console.error(errorMessage(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    const server = httpServer;
    if (!server) return reject(new Error("HTTP server failed to initialize"));
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.error(
    `garmin-coach-mcp Streamable HTTP listening on ${host}:${port}`
  );
}

export async function closeHttpServer(): Promise<void> {
  await Promise.all(
    [...sessions.values()].map(async ({ transport, server }) => {
      try {
        await transport.close();
      } catch {
        // Continue closing the remaining sessions and listener.
      }
      try {
        await server.close();
      } catch {
        // The transport close already releases the session resources.
      }
    })
  );
  sessions.clear();
  const server = httpServer;
  httpServer = null;
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
