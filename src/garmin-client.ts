import { existsSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";

import {
  ensurePrivateDir,
  hardenTree,
  LOCAL_PATHS,
  ProcessLock,
} from "./local-state.js";

export type GarminMethod = "GET" | "POST" | "PUT" | "PATCH";

const BASE_URL = "https://connect.garmin.com/app/";
const STATIC_URL =
  "https://connect.garmin.com/site-status/garmin-connect-status.json";
const API_PATH = /^[A-Za-z0-9][A-Za-z0-9/_-]*\/?$/;
const SESSION_CHECK = "userprofile-service/userprofile/user-settings/";

function browserEnvironment(headless: boolean) {
  if (headless || process.env.DISPLAY) return process.env;
  const uid = process.getuid?.();
  const display = existsSync("/tmp/.X11-unix/X1") ? ":1" : ":0";
  return {
    ...process.env,
    DISPLAY: display,
    ...(uid === undefined
      ? {}
      : {
          XAUTHORITY: `/run/user/${uid}/gdm/Xauthority`,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
        }),
  };
}

export async function waitForGarminSession(page: Page): Promise<string> {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = await page.evaluate(async (path) => {
      const csrf = document
        .querySelector('meta[name="csrf-token"]')
        ?.getAttribute("content");
      if (!csrf) return 0;
      return fetch(`/gc-api/${path}`, {
        credentials: "include",
        headers: { "connect-csrf-token": csrf, Accept: "*/*" },
      }).then((response) => response.status);
    }, SESSION_CHECK);
    if (status === 200) {
      const csrf = await page
        .locator('meta[name="csrf-token"]')
        .getAttribute("content");
      if (csrf) return csrf;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    "Garmin session missing, expired, or not ready; run pnpm auth"
  );
}

export function validApiPath(path: string): string {
  const normalized = path.replace(/^\/+/, "");
  if (!API_PATH.test(normalized) || normalized.includes("..")) {
    throw new Error("Invalid Garmin API path");
  }
  return normalized;
}

export async function launchGarminContext(headless: boolean) {
  const lock = await ProcessLock.acquire();
  try {
    await ensurePrivateDir(LOCAL_PATHS.browserProfile);
    await hardenTree(LOCAL_PATHS.browserProfile);
    const context = await chromium.launchPersistentContext(
      LOCAL_PATHS.browserProfile,
      {
        channel: "chrome",
        headless,
        env: browserEnvironment(headless),
        ignoreDefaultArgs: ["--enable-automation"],
        viewport: { width: 1440, height: 1000 },
        args: [
          "--disable-blink-features=AutomationControlled",
          "--disable-save-password-bubble",
          "--disable-features=AutofillEnableAccountWalletStorage,AutofillServerCommunication,PasswordManagerOnboarding,PasswordLeakDetection",
        ],
      }
    );
    return { context, lock };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

export class GarminClient {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private lock: ProcessLock | null = null;
  private csrfToken: string | null = null;
  private initPromise: Promise<Page> | null = null;

  private async init(): Promise<Page> {
    if (this.page) return this.page;
    this.initPromise ??= this.start();
    try {
      return await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async start(): Promise<Page> {
    const launched = await launchGarminContext(true);
    this.context = launched.context;
    this.lock = launched.lock;
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    try {
      this.csrfToken = await waitForGarminSession(this.page);
      await this.page.goto(STATIC_URL, { waitUntil: "domcontentloaded" });
    } catch (error) {
      await this.close();
      throw error;
    }
    return this.page;
  }

  async get(
    path: string,
    params: Record<string, string | number | boolean> = {}
  ): Promise<unknown> {
    const query = new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)])
    );
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request("GET", `${validApiPath(path)}${suffix}`);
  }

  async request(
    method: GarminMethod,
    pathWithQuery: string,
    body?: unknown
  ): Promise<unknown> {
    const [path, query = ""] = pathWithQuery.split("?", 2);
    const endpoint = `${validApiPath(path)}${query ? `?${query}` : ""}`;
    const page = await this.init();
    let result = await this.send(page, method, endpoint, body);
    if (result.status === 401 || result.status === 403) {
      this.csrfToken = await waitForGarminSession(page);
      await page.goto(STATIC_URL, { waitUntil: "domcontentloaded" });
      result = await this.send(page, method, endpoint, body);
    }
    if (!result.ok) {
      if (result.status === 401 || result.status === 403) await this.close();
      throw new Error(
        `Garmin request failed: ${method} ${path} returned HTTP ${result.status}`
      );
    }
    return result.data;
  }

  private async send(
    page: Page,
    method: GarminMethod,
    endpoint: string,
    body?: unknown
  ) {
    const csrf = this.csrfToken;
    if (!csrf) throw new Error("Garmin session missing; run pnpm auth");
    return page.evaluate(
      async ({ requestMethod, requestPath, requestBody, csrfToken }) => {
        const headers: Record<string, string> = {
          Accept: requestMethod === "GET" ? "*/*" : "application/json, */*",
          "connect-csrf-token": csrfToken,
        };
        if (requestBody !== undefined)
          headers["Content-Type"] = "application/json";
        const response = await fetch(`/gc-api/${requestPath}`, {
          method: requestMethod,
          credentials: "include",
          headers,
          ...(requestBody === undefined
            ? {}
            : { body: JSON.stringify(requestBody) }),
        });
        const text = await response.text();
        let data: unknown = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch {
            data = null;
          }
        }
        return { ok: response.ok, status: response.status, data };
      },
      {
        requestMethod: method,
        requestPath: endpoint,
        requestBody: body,
        csrfToken: csrf,
      }
    );
  }

  async close(): Promise<void> {
    const context = this.context;
    const lock = this.lock;
    this.context = null;
    this.page = null;
    this.lock = null;
    this.csrfToken = null;
    this.initPromise = null;
    await context?.close().catch(() => undefined);
    await hardenTree(LOCAL_PATHS.browserProfile).catch(() => undefined);
    await lock?.release();
  }
}

let shared: GarminClient | null = null;

export function getClient(): GarminClient {
  shared ??= new GarminClient();
  return shared;
}

export async function closeClient(): Promise<void> {
  const client = shared;
  shared = null;
  await client?.close();
}
