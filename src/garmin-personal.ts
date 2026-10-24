import type { GarminRequester } from "./garmin-client.js";

export const DEFAULT_PERSONAL_BASE_URL =
  "https://personal.connectapi.garmin.com";
const TOKEN_PATH =
  "personalapitoken-service/personal-api/personal-api-key/token";
const REFRESH_SKEW_SECONDS = 300;
const FALLBACK_TOKEN_TTL_SECONDS = 23 * 3600;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Params = Record<string, string | number | boolean>;

export type PersonalRoute = { path: string; params: Params };

export function personalBaseUrl(
  value = process.env.GARMIN_PERSONAL_API_BASE_URL
): string {
  const candidate = (value?.trim() || DEFAULT_PERSONAL_BASE_URL).replace(
    /\/+$/,
    ""
  );
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("GARMIN_PERSONAL_API_BASE_URL must be a valid HTTPS URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error("GARMIN_PERSONAL_API_BASE_URL must be a valid HTTPS URL");
  }
  return parsed.toString().replace(/\/+$/, "");
}

/**
 * Maps the unofficial connectapi read routes used by the tools onto the
 * documented read-only Personal API equivalents. Routes the Personal API does
 * not offer (training readiness/status, workouts, calendar, profile and HR
 * zones, every write) return undefined and keep using the SSO path.
 */
export function toPersonalRoute(
  path: string,
  params: Params,
  today = new Date().toISOString().slice(0, 10)
): PersonalRoute | undefined {
  const pathname = path.split("?")[0].replace(/\/+$/, "");
  const date =
    typeof params.date === "string" && DATE.test(params.date)
      ? params.date
      : today;
  switch (pathname) {
    case "sleep-service/sleep/dailySleepData":
      return { path: "sleep-service/sleep/dailySleep", params: { date } };
    case "wellness-service/wellness/bodyBattery/messagingToday":
      return {
        path: "wellness-service/wellness/bodyBattery/reports/daily",
        params: { startDate: date, endDate: date },
      };
    case "wellness-service/wellness/dailyHeartRate":
      return { path: pathname, params: { date } };
    case "activitylist-service/activities/search/activities":
      return { path: pathname, params: { ...params } };
  }
  if (/^hrv-service\/hrv\/\d{4}-\d{2}-\d{2}$/.test(pathname)) {
    return { path: pathname, params: {} };
  }
  if (/^activity-service\/activity\/\d+$/.test(pathname)) {
    return { path: pathname, params: {} };
  }
  return undefined;
}

function jwtExpiry(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const exp = Number(
      (
        JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
          exp?: unknown;
        }
      ).exp
    );
    return Number.isFinite(exp) && exp > 0 ? exp : undefined;
  } catch {
    return undefined;
  }
}

function epochSeconds(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed > 1e12 ? Math.floor(parsed / 1000) : parsed;
}

export function parseTokenResponse(
  text: string,
  now: number
): { token: string; expiresAt: number } {
  let token = text.trim();
  let expiresAt: number | undefined;
  if (token.startsWith("{")) {
    const json = JSON.parse(token) as Record<string, unknown>;
    const candidate = json.access_token ?? json.accessToken ?? json.token;
    if (typeof candidate !== "string") {
      throw new Error("Garmin Personal API token response had no token");
    }
    token = candidate;
    expiresAt = epochSeconds(json.expires_at ?? json.expiresAt);
    const ttl = Number(json.expires_in ?? json.expiresIn);
    if (expiresAt === undefined && Number.isFinite(ttl) && ttl > 0) {
      expiresAt = now + ttl;
    }
  } else if (token.startsWith('"')) {
    token = String(JSON.parse(token));
  }
  token = token.replace(/^Bearer\s+/i, "").trim();
  if (!token || /\s/.test(token)) {
    throw new Error("Garmin Personal API returned an unusable token");
  }
  return {
    token,
    expiresAt:
      expiresAt ?? jwtExpiry(token) ?? now + FALLBACK_TOKEN_TTL_SECONDS,
  };
}

export type PersonalTokenProviderOptions = {
  apiKey: string;
  baseUrl: string;
  requester: GarminRequester;
  impersonate: string;
  timeoutSeconds?: number;
  now?: () => number;
};

/**
 * Exchanges a Garmin Connect Personal API key for a 24-hour bearer token.
 * There is no refresh token: a new token is minted from the key. The key and
 * token live in memory only and are never included in errors.
 */
export class PersonalApiTokenProvider {
  private cached: { token: string; expiresAt: number } | undefined;
  private pending: Promise<string> | undefined;
  private readonly now: () => number;

  constructor(private readonly options: PersonalTokenProviderOptions) {
    this.now = options.now || (() => Math.floor(Date.now() / 1000));
  }

  getToken(): Promise<string> {
    const cached = this.cached;
    if (cached && cached.expiresAt - REFRESH_SKEW_SECONDS > this.now()) {
      return Promise.resolve(cached.token);
    }
    this.pending ??= this.exchange().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  invalidate(rejectedToken?: string): void {
    if (!rejectedToken || this.cached?.token === rejectedToken) {
      this.cached = undefined;
    }
  }

  private async exchange(): Promise<string> {
    const response = await this.options.requester(
      "POST",
      `${this.options.baseUrl}/${TOKEN_PATH}`,
      {
        headers: {
          Accept: "application/json, text/plain;q=0.9",
          Authorization: `ApiKey ${this.options.apiKey}`,
        },
        impersonate: this.options.impersonate,
        timeout: this.options.timeoutSeconds || 30,
      }
    );
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "Garmin Personal API key was rejected: it may be expired or deleted. Create a new key in Garmin Connect settings."
      );
    }
    if (response.status === 429) {
      throw new Error("Garmin Personal API token exchange was rate limited");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Garmin Personal API token exchange failed with HTTP ${response.status}`
      );
    }
    this.cached = parseTokenResponse(response.text, this.now());
    return this.cached.token;
  }
}
