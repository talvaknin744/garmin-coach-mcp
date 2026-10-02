import {
  createGarminConnectClient,
  createMemoryTokenStore,
  type GarminConnectClient,
} from "@kaiord/garmin-connect";
import { Session } from "impers";

type GarminOAuthTokens = {
  oauth2: {
    access_token: string;
    expires_at: number;
  };
};

const DEFAULT_SSO_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1_000;

export type GarminAuthClient = Pick<GarminConnectClient, "auth" | "service"> & {
  close?: () => Promise<void>;
};
export type GarminAuthClientFactory = () => GarminAuthClient;
export type GarminSsoSession = Pick<Session, "request" | "close">;

export class GarminSsoRateLimitError extends Error {
  constructor(readonly retryAfterMs?: number) {
    const retrySeconds =
      retryAfterMs === undefined ? undefined : Math.ceil(retryAfterMs / 1_000);
    super(
      retrySeconds === undefined
        ? "Garmin SSO rate limit reached"
        : `Garmin SSO rate limit reached; retry after ${retrySeconds} seconds`
    );
    this.name = "GarminSsoRateLimitError";
  }
}

export type GarminCredentialProviderOptions = {
  email?: string;
  password?: string;
  createClient?: GarminAuthClientFactory;
  now?: () => number;
  nowMilliseconds?: () => number;
};

function parseRetryAfter(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt)
    ? Math.max(0, retryAt - Date.now())
    : undefined;
}

function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  email: string;
  password: string;
} {
  const email = env.GARMIN_EMAIL?.trim();
  const password = env.GARMIN_PASSWORD;
  if (!email || !password?.trim()) {
    throw new Error(
      "Missing Garmin login credentials: set GARMIN_EMAIL and GARMIN_PASSWORD"
    );
  }
  return { email, password };
}

export function createGarminSsoFetch(
  session: GarminSsoSession
): typeof globalThis.fetch {
  return async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method =
      init?.method || (input instanceof Request ? input.method : "GET");
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body;
    const content =
      typeof body === "string"
        ? body
        : body instanceof URLSearchParams
          ? body.toString()
          : body instanceof Uint8Array
            ? Buffer.from(body)
            : undefined;
    const response = await session.request(method, url, {
      headers,
      ...(content === undefined ? {} : { content }),
      ...(init?.signal ? { signal: init.signal } : {}),
      impersonate: "chrome",
      timeout: 30,
    });
    if (response.status === 429) {
      throw new GarminSsoRateLimitError(
        parseRetryAfter(response.headers.get("retry-after"))
      );
    }
    return new Response(new Uint8Array(response.content), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers.toObject(),
    });
  };
}

function quietClient(): GarminAuthClient {
  const session = new Session({ impersonate: "chrome" });
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const client = createGarminConnectClient({
    logger,
    tokenStore: createMemoryTokenStore(),
    fetchFn: createGarminSsoFetch(session),
  });
  return { ...client, close: () => session.close() };
}

export class GarminCredentialProvider {
  private readonly email: string;
  private readonly password: string;
  private readonly client: GarminAuthClient;
  private readonly now: () => number;
  private readonly nowMilliseconds: () => number;
  private operation: Promise<string> | undefined;
  private loginCooldownUntil = 0;

  constructor(options: GarminCredentialProviderOptions = {}) {
    const credentials =
      options.email && options.password
        ? { email: options.email, password: options.password }
        : credentialsFromEnv();
    this.email = credentials.email;
    this.password = credentials.password;
    this.client = (options.createClient || quietClient)();
    this.now = options.now || (() => Math.floor(Date.now() / 1000));
    this.nowMilliseconds = options.nowMilliseconds || Date.now;
  }

  async getToken(): Promise<string> {
    return this.serialized(async () => {
      if (!this.client.auth.is_authenticated()) {
        const tokens = await this.exportTokens().catch(() => undefined);
        if (!tokens) await this.fullLogin();
        else await this.refreshOrLogin();
      }

      let tokens = await this.exportTokens();
      if (tokens.oauth2.expires_at <= this.now()) {
        await this.refreshOrLogin();
        tokens = await this.exportTokens();
      }
      if (!tokens.oauth2.access_token) {
        throw new Error("Garmin authentication did not return an access token");
      }
      return tokens.oauth2.access_token;
    });
  }

  async recoverRejectedToken(rejectedToken: string): Promise<string> {
    return this.serialized(async () => {
      const current = await this.exportTokens().catch(() => undefined);
      if (
        current?.oauth2.access_token &&
        current.oauth2.access_token !== rejectedToken
      ) {
        return current.oauth2.access_token;
      }

      try {
        await this.client.service.list({ limit: 1 });
      } catch {
        await this.fullLogin();
      }
      return (await this.exportTokens()).oauth2.access_token;
    });
  }

  async close(): Promise<void> {
    await this.client.close?.();
  }

  private async exportTokens(): Promise<GarminOAuthTokens> {
    return (await this.client.auth.export_tokens()) as GarminOAuthTokens;
  }

  private async fullLogin(): Promise<void> {
    const now = this.nowMilliseconds();
    if (this.loginCooldownUntil > now) {
      throw new GarminSsoRateLimitError(this.loginCooldownUntil - now);
    }
    await this.client.auth.logout().catch(() => undefined);
    try {
      await this.client.auth.login(this.email, this.password);
      this.loginCooldownUntil = 0;
    } catch (error) {
      if (error instanceof GarminSsoRateLimitError) {
        const cooldownMs =
          error.retryAfterMs ?? DEFAULT_SSO_RATE_LIMIT_COOLDOWN_MS;
        this.loginCooldownUntil = this.nowMilliseconds() + cooldownMs;
        throw new GarminSsoRateLimitError(cooldownMs);
      }
      throw error;
    }
  }

  private async refreshOrLogin(): Promise<void> {
    try {
      // The Garmin SDK automatically exchanges the OAuth1 token for a fresh
      // OAuth2 access/refresh-token pair when the access token has expired.
      // A harmless read forces that refresh before a new API call is sent.
      await this.client.service.list({ limit: 1 });
    } catch {
      // Expired/revoked refresh credentials require a new Garmin SSO login.
      await this.fullLogin();
    }
  }

  private serialized(operation: () => Promise<string>): Promise<string> {
    if (this.operation) return this.operation;

    const run = operation();
    this.operation = run;
    void run.then(
      () => {
        if (this.operation === run) this.operation = undefined;
      },
      () => {
        if (this.operation === run) this.operation = undefined;
      }
    );
    return run;
  }
}

let sharedProvider: GarminCredentialProvider | undefined;

export function getGarminCredentialProvider(): GarminCredentialProvider {
  sharedProvider ??= new GarminCredentialProvider();
  return sharedProvider;
}
