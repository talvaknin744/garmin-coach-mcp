import * as impers from "impers";
import {
  getGarminCredentialProvider,
  type GarminCredentialProvider,
} from "./garmin-auth.js";

const DEFAULT_API_BASE_URL = "https://connectapi.garmin.com";
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_IMPERSONATE = "chrome";
const MAX_PATH_LENGTH = 512;

export type GarminMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type GarminRequestOptions = {
  headers: Record<string, string>;
  params?: Record<string, string | number | boolean>;
  json?: unknown;
  impersonate: string;
  timeout: number;
};

export type GarminResponse = {
  status: number;
  text: string;
  content: Buffer;
};

export type GarminRequester = (
  method: GarminMethod,
  url: string,
  options: GarminRequestOptions
) => Promise<GarminResponse>;

type GarminTokenProvider = Pick<
  GarminCredentialProvider,
  "getToken" | "recoverRejectedToken"
> & { close?: () => Promise<void> };

export type GarminClientOptions = {
  token?: string;
  tokenProvider?: GarminTokenProvider;
  baseUrl?: string;
  timeoutSeconds?: number;
  impersonate?: string;
  requester?: GarminRequester;
};

export class GarminApiError extends Error {
  constructor(
    readonly method: GarminMethod,
    readonly path: string,
    readonly status: number
  ) {
    super(messageForStatus(method, path, status));
    this.name = "GarminApiError";
  }
}

function requiredToken(token = process.env.GARMIN_TOKEN): string {
  const value = token?.trim();
  if (!value)
    throw new Error("Missing required environment variable: GARMIN_TOKEN");
  return value;
}

function apiBaseUrl(value = process.env.GARMIN_API_BASE_URL): string {
  const candidate = (value?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("GARMIN_API_BASE_URL must be a valid HTTPS URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error("GARMIN_API_BASE_URL must be a valid HTTPS URL");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function timeoutSeconds(
  value = process.env.GARMIN_HTTP_TIMEOUT_SECONDS
): number {
  if (!value?.trim()) return DEFAULT_TIMEOUT_SECONDS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 120) {
    throw new Error("GARMIN_HTTP_TIMEOUT_SECONDS must be between 1 and 120");
  }
  return parsed;
}

function messageForStatus(
  method: GarminMethod,
  path: string,
  status: number
): string {
  const request = `${method} ${path}`;
  if (status === 401)
    return `${request} failed: GARMIN_TOKEN was rejected or has expired`;
  if (status === 403) return `${request} failed: Garmin denied this request`;
  if (status === 429) return `${request} failed: Garmin rate limit reached`;
  if (status >= 500)
    return `${request} failed: Garmin API is temporarily unavailable`;
  return `${request} failed with HTTP ${status}`;
}

function defaultRequester(
  method: GarminMethod,
  url: string,
  options: GarminRequestOptions
): Promise<GarminResponse> {
  return impers
    .request(method, url, options as Parameters<typeof impers.request>[2])
    .then((response) => ({
      status: response.status,
      text: response.text,
      content: Buffer.from(response.content),
    }));
}

function validApiPath(path: string): string {
  if (
    !path ||
    path.length > MAX_PATH_LENGTH ||
    path.startsWith("/") ||
    path.includes("//")
  ) {
    throw new Error(
      "Garmin API path must be a short relative allowlisted path"
    );
  }
  const parsed = new URL(path, "https://garmin.invalid");
  if (
    parsed.origin !== "https://garmin.invalid" ||
    parsed.pathname.slice(1) !== path.split("?")[0]
  ) {
    throw new Error("Garmin API path must be relative allowlisted path");
  }
  if (
    parsed.pathname
      .split("/")
      .some((segment) => segment === ".." || segment === ".")
  ) {
    throw new Error("Garmin API path traversal is not allowed");
  }
  return path;
}

function splitPath(path: string): {
  pathname: string;
  params: Record<string, string>;
} {
  const parsed = new URL(path, "https://garmin.invalid");
  const params: Record<string, string> = {};
  parsed.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  return { pathname: parsed.pathname, params };
}

function parsedResponse(
  response: GarminResponse,
  method: GarminMethod,
  path: string
): unknown {
  if (response.status < 200 || response.status >= 300) {
    throw new GarminApiError(method, path, response.status);
  }
  if (!response.text.trim()) return null;
  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    return response.text;
  }
}

export function assertGarminConfig(env: NodeJS.ProcessEnv = process.env): void {
  const hasToken = Boolean(env.GARMIN_TOKEN?.trim());
  const hasEmail = Boolean(env.GARMIN_EMAIL?.trim());
  const hasPassword = Boolean(env.GARMIN_PASSWORD?.trim());
  if (hasEmail !== hasPassword) {
    throw new Error("Set both GARMIN_EMAIL and GARMIN_PASSWORD");
  }
  if (!hasToken && !hasEmail) {
    throw new Error(
      "Set GARMIN_EMAIL and GARMIN_PASSWORD, or provide GARMIN_TOKEN"
    );
  }
  apiBaseUrl(env.GARMIN_API_BASE_URL);
  timeoutSeconds(env.GARMIN_HTTP_TIMEOUT_SECONDS);
}

export class GarminClient {
  private readonly token?: string;
  private readonly baseUrl?: string;
  private readonly timeout?: number;
  private readonly impersonate: string;
  private readonly requester: GarminRequester;
  private readonly tokenProvider?: GarminTokenProvider;

  constructor(options: GarminClientOptions = {}) {
    const credentialsConfigured = Boolean(
      process.env.GARMIN_EMAIL?.trim() && process.env.GARMIN_PASSWORD?.trim()
    );
    this.token =
      options.token?.trim() ||
      (credentialsConfigured ? undefined : process.env.GARMIN_TOKEN?.trim()) ||
      undefined;
    this.tokenProvider = options.tokenProvider;
    this.baseUrl = options.baseUrl ? apiBaseUrl(options.baseUrl) : undefined;
    this.timeout = options.timeoutSeconds;
    this.impersonate =
      options.impersonate ||
      process.env.GARMIN_IMPERSONATE ||
      DEFAULT_IMPERSONATE;
    this.requester = options.requester || defaultRequester;
  }

  async get(
    path: string,
    params: Record<string, string | number | boolean> = {}
  ): Promise<unknown> {
    return this.request("GET", path, undefined, params);
  }

  async getBytes(
    path: string,
    params: Record<string, string | number | boolean> = {}
  ): Promise<Buffer> {
    const response = await this.send("GET", path, undefined, params);
    if (response.status < 200 || response.status >= 300) {
      throw new GarminApiError("GET", path, response.status);
    }
    return response.content;
  }

  async request(
    method: GarminMethod,
    path: string,
    body?: unknown,
    params: Record<string, string | number | boolean> = {}
  ): Promise<unknown> {
    const response = await this.send(method, path, body, params);
    return parsedResponse(response, method, path);
  }

  async close(): Promise<void> {
    if (this.token) return;
    await (this.tokenProvider || getGarminCredentialProvider()).close?.();
  }

  private async send(
    method: GarminMethod,
    rawPath: string,
    body: unknown,
    params: Record<string, string | number | boolean>
  ): Promise<GarminResponse> {
    const path = validApiPath(rawPath);
    const { pathname, params: pathParams } = splitPath(path);
    const baseUrl = this.baseUrl || apiBaseUrl();
    const url = new URL(`${baseUrl}${pathname}`);
    const mergedParams = { ...pathParams, ...params };
    Object.entries(mergedParams).forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });
    const options: GarminRequestOptions = {
      headers: { Accept: "application/json, application/octet-stream;q=0.9" },
      impersonate: this.impersonate,
      timeout: this.timeout || timeoutSeconds(),
    };
    if (body !== undefined) options.json = body;
    const token = await this.currentToken();
    options.headers.Authorization = `Bearer ${token}`;
    const response = await this.requester(method, url.toString(), options);
    const provider = this.authProvider();
    if (response.status !== 401 || !provider) return response;

    const replacement = await provider.recoverRejectedToken(token);
    options.headers.Authorization = `Bearer ${replacement}`;
    return this.requester(method, url.toString(), options);
  }

  private authProvider() {
    if (this.token) return undefined;
    return this.tokenProvider || getGarminCredentialProvider();
  }

  private currentToken(): Promise<string> {
    if (this.token) return Promise.resolve(this.token);
    const provider = this.authProvider();
    return provider ? provider.getToken() : Promise.resolve(requiredToken());
  }
}

let shared: GarminClient | null = null;

export function getClient(): GarminClient {
  shared ??= new GarminClient();
  return shared;
}

export async function closeClient(): Promise<void> {
  await shared?.close();
  shared = null;
}
