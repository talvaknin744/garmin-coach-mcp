import { createHash } from "node:crypto";
import type { Page } from "playwright";

import { launchGarminContext, waitForGarminSession } from "./garmin-client.js";
import {
  normalizeProfile,
  type ProfileWriteContract,
  ProfileWriteContractSchema,
  type RawProfile,
} from "./profile.js";
import { LOCAL_PATHS, writePrivateJson } from "./local-state.js";
import { canonicalJson } from "./safety.js";

const PROFILE_PATH = "userprofile-service/userprofile/user-settings/";
const ZONES_PATH = "biometric-service/heartRateZones/";
const DEVICE_PATH = "device-service/deviceregistration/devices";
const BUNDLE_PROOF = [
  'HR_RESERVE:"HR_RESERVE"',
  'return"/biometric-service/heartRateZones/"',
  'type:"PUT"',
  "JSON.stringify(this.changedSports)",
] as const;
const REQUIRED_ZONE_FIELDS = [
  "sport",
  "changeState",
  "trainingMethod",
  "maxHeartRateUsed",
  "restingHeartRateUsed",
  "lactateThresholdHeartRateUsed",
  "zone1Floor",
  "zone2Floor",
  "zone3Floor",
  "zone4Floor",
  "zone5Floor",
] as const;

export type CapturedRequest = {
  method: string;
  url: string;
  postData: string | null;
};

export async function captureAfterSuccessfulAbort(
  request: CapturedRequest,
  abort: () => Promise<unknown>
): Promise<CapturedRequest> {
  await abort();
  return request;
}

async function readJson(page: Page, path: string, csrf: string) {
  return page.evaluate(
    async ({ requestPath, token }) => {
      const response = await fetch(`/gc-api/${requestPath}`, {
        credentials: "include",
        headers: { "connect-csrf-token": token, Accept: "*/*" },
      });
      if (!response.ok)
        throw new Error(`Garmin read failed with HTTP ${response.status}`);
      return response.json() as Promise<unknown>;
    },
    { requestPath: path, token: csrf }
  );
}

function devices(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value))
    return value.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item)
    );
  if (!value || typeof value !== "object") return [];
  const nested = (value as Record<string, unknown>).devices;
  return devices(nested);
}

function primaryDevice(items: Record<string, unknown>[]) {
  return (
    items.find(({ primaryActivityTrackerIndicator }) =>
      Boolean(primaryActivityTrackerIndicator)
    ) ?? items.find(({ primary }) => Boolean(primary))
  );
}

function deviceId(device: Record<string, unknown>): string {
  const value = device.deviceId ?? device.unitId;
  if (!(typeof value === "string" || typeof value === "number")) {
    throw new Error("Primary Garmin device identifier is missing");
  }
  return String(value);
}

async function findContractBundle(page: Page) {
  const match = await page.evaluate(async (proof) => {
    const urls = [
      ...new Set(
        performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((url) => /\.js(?:\?|$)/.test(url))
      ),
    ];
    for (const url of urls) {
      try {
        const body = await fetch(url).then((response) =>
          response.ok ? response.text() : ""
        );
        if (proof.every((needle) => body.includes(needle))) {
          return { path: new URL(url).pathname, body };
        }
      } catch {
        // Keep checking Garmin's other published bundles.
      }
    }
    return null;
  }, BUNDLE_PROOF);
  if (!match) {
    throw new Error("Garmin HR-zone write contract was not found in the app");
  }
  return match;
}

export function findHeartRateModuleId(bundleBody: string): number {
  const endpoint = bundleBody.indexOf('"/biometric-service/heartRateZones/"');
  if (endpoint < 0) throw new Error("Garmin HR-zone model endpoint is missing");
  const prefix = bundleBody.slice(0, endpoint);
  const matches = [...prefix.matchAll(/(?:^|[,{])(\d+):\(e,t,i\)=>\{/g)];
  const match = matches.at(-1);
  const moduleId = Number(match?.[1]);
  const moduleStart = match?.index ?? -1;
  const modelSource = bundleBody.slice(moduleStart, endpoint + 500);
  if (
    !Number.isSafeInteger(moduleId) ||
    moduleStart < 0 ||
    !modelSource.includes("JSON.stringify(this.changedSports)") ||
    !modelSource.includes('type:"PUT"')
  ) {
    throw new Error("Garmin HR-zone save model could not be identified");
  }
  return moduleId;
}

function zoneRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value))
    throw new Error("Garmin HR zones are not an array");
  return value.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item)
  );
}

export function validateUnchangedRequest(
  request: CapturedRequest,
  currentZones: unknown
): ProfileWriteContract["observedRequest"] {
  if (request.method !== "PUT") {
    throw new Error("Captured HR-zone request did not use PUT");
  }
  const path = new URL(request.url).pathname;
  if (path !== `/gc-api/${ZONES_PATH}`) {
    throw new Error("Captured HR-zone request used an unexpected route");
  }
  if (!request.postData)
    throw new Error("Captured HR-zone request had no body");
  let body: unknown;
  try {
    body = JSON.parse(request.postData);
  } catch {
    throw new Error("Captured HR-zone request body was not JSON");
  }
  const items = zoneRecords(body);
  if (items.length !== 1) {
    throw new Error(
      "Captured HR-zone request did not contain one changed sport"
    );
  }
  const item = items[0];
  if (item.sport !== "DEFAULT" || item.changeState !== "CHANGED") {
    throw new Error(
      "Captured HR-zone request was not an unchanged default save"
    );
  }
  const current = zoneRecords(currentZones).find(
    ({ sport }) => sport === "DEFAULT"
  );
  if (!current) throw new Error("Current default HR zones are missing");
  const unchanged = { ...item };
  const currentValues = { ...current };
  delete unchanged.changeState;
  delete currentValues.changeState;
  if (canonicalJson(unchanged) !== canonicalJson(currentValues)) {
    throw new Error("Captured HR-zone request changed profile values");
  }
  const fields = Object.keys(item).sort();
  if (REQUIRED_ZONE_FIELDS.some((field) => !fields.includes(field))) {
    throw new Error("Captured HR-zone request shape is incomplete");
  }
  return {
    blockedBeforeSend: true,
    itemCount: 1,
    sport: "DEFAULT",
    changeState: "CHANGED",
    fields,
  };
}

async function captureUnchangedSave(
  page: Page,
  bundle: { path: string; body: string },
  zones: unknown
) {
  const moduleId = findHeartRateModuleId(bundle.body);
  await page.addScriptTag({
    url: new URL(bundle.path, "https://connect.garmin.com").href,
  });
  let resolveCapture: (request: CapturedRequest) => void = () => {};
  let rejectCapture: (error: unknown) => void = () => {};
  const captured = new Promise<CapturedRequest>((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
  });
  const routePattern = `**/gc-api/${ZONES_PATH}`;
  await page.route(routePattern, async (route) => {
    const request = route.request();
    if (request.method() !== "PUT") return route.continue();
    try {
      resolveCapture(
        await captureAfterSuccessfulAbort(
          {
            method: request.method(),
            url: request.url(),
            postData: request.postData(),
          },
          () => route.abort("blockedbyclient")
        )
      );
    } catch (error) {
      rejectCapture(error);
    }
  });
  try {
    const invoked = await page.evaluate(
      ({ currentZones, garminModuleId }) => {
        const chunks = (
          globalThis as typeof globalThis & {
            webpackChunkreact_web?: unknown[];
          }
        ).webpackChunkreact_web;
        if (!Array.isArray(chunks)) return false;
        const runtime: {
          loadModule?: (id: number) => { A?: new (value: unknown) => any };
        } = {};
        chunks.push([
          [Math.floor(Math.random() * 1_000_000_000)],
          {},
          (loader: NonNullable<typeof runtime.loadModule>) => {
            runtime.loadModule = loader;
          },
        ]);
        const Model = runtime.loadModule?.(garminModuleId).A;
        if (!Model) return false;
        const model = new Model(currentZones);
        const current = model.findBySport("DEFAULT");
        if (!current) return false;
        model.replaceHRZone(structuredClone(current), false, false);
        const saved = model.save();
        if (saved && typeof saved.fail === "function") {
          saved.fail(() => undefined);
        }
        return true;
      },
      { currentZones: zones, garminModuleId: moduleId }
    );
    if (!invoked) throw new Error("Garmin HR-zone save model was not callable");
    const request = await Promise.race([
      captured,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Garmin HR-zone save capture timed out")),
          10_000
        )
      ),
    ]);
    return validateUnchangedRequest(request, zones);
  } finally {
    await page.unroute(routePattern).catch(() => undefined);
  }
}

export function validateContractCoverage(
  inputContract: ProfileWriteContract,
  raw: RawProfile
): void {
  const contract = ProfileWriteContractSchema.parse(inputContract);
  const normalized = normalizeProfile(raw);
  if (!normalized.zones.ranges.default) {
    throw new Error("Capture refused: default HR zones are missing");
  }
  if (normalized.zones.ranges.walking && !contract.scopes.walking) {
    throw new Error("Capture refused: walking HR zones were not declared");
  }
  if (
    REQUIRED_ZONE_FIELDS.some(
      (field) => !contract.observedRequest.fields.includes(field)
    )
  ) {
    throw new Error("Capture refused: observed request shape is incomplete");
  }
}

export async function captureProfileContract(): Promise<void> {
  const { context, lock } = await launchGarminContext(true);
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    const csrf = await waitForGarminSession(page);
    const registered = devices(await readJson(page, DEVICE_PATH, csrf));
    const primary = primaryDevice(registered);
    if (!primary) throw new Error("No primary Garmin device was found");
    const id = deviceId(primary);
    await page.goto(
      `https://connect.garmin.com/app/device/${encodeURIComponent(id)}/settings`,
      { waitUntil: "domcontentloaded" }
    );
    await page.waitForTimeout(8_000);
    const [profile, zones, bundle] = await Promise.all([
      readJson(page, PROFILE_PATH, csrf),
      readJson(page, ZONES_PATH, csrf),
      findContractBundle(page),
    ]);
    const observedRequest = await captureUnchangedSave(page, bundle, zones);
    const contract = ProfileWriteContractSchema.parse({
      version: 3,
      capturedAt: new Date().toISOString(),
      method: "PUT",
      path: ZONES_PATH,
      payloadType: "changed-sports-array",
      calculationBasisValue: "HR_RESERVE",
      scopes: {
        default: true,
        running: Boolean(primary.runningHeartRateZoneCapable),
        walking: Boolean(primary.walkingHeartRateZoneCapable),
      },
      bundle: {
        path: bundle.path,
        sha256: createHash("sha256").update(bundle.body).digest("hex"),
      },
      observedRequest,
    });
    validateContractCoverage(contract, { profile, zones });
    await writePrivateJson(LOCAL_PATHS.profileContract, contract);
    process.stdout.write(
      `${JSON.stringify(
        {
          method: contract.method,
          path: contract.path,
          payloadType: contract.payloadType,
          calculationBasisValue: contract.calculationBasisValue,
          scopes: contract.scopes,
          bundle: contract.bundle.path,
          observedRequest: contract.observedRequest,
        },
        null,
        2
      )}\nCaptured blocked, redacted contract saved with mode 0600.\n`
    );
  } finally {
    await context.close().catch(() => undefined);
    await lock.release();
  }
}
