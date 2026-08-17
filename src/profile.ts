import { z } from "zod";

import { canonicalHash, canonicalJson, errorMessage } from "./safety.js";

export const APPROVED_HR_PROFILE = {
  maximumHeartRate: 189,
  restingHeartRate: 55,
  lactateThresholdHeartRate: 181,
  calculationBasis: "heart-rate-reserve/custom-bpm",
  zones: [
    { zone: 1, low: 122, high: 134 },
    { zone: 2, low: 135, high: 149 },
    { zone: 3, low: 150, high: 162 },
    { zone: 4, low: 163, high: 176 },
    { zone: 5, low: 177, high: 189 },
  ],
  scopes: ["default", "running", "walking-if-supported"],
  provenance: {
    status: "provisional",
    age: 27,
    restingHeartRate: 55,
    estimatedMaximumHeartRate: 189,
    manualLactateThresholdHeartRate: 181,
  },
} as const;

type Scope = "default" | "running" | "walking";
type ZoneRange = { low: number; high: number };

export const ProfileWriteContractSchema = z.object({
  version: z.literal(3),
  capturedAt: z.string().datetime(),
  method: z.literal("PUT"),
  path: z.literal("biometric-service/heartRateZones/"),
  payloadType: z.literal("changed-sports-array"),
  calculationBasisValue: z.literal("HR_RESERVE"),
  scopes: z.object({
    default: z.literal(true),
    running: z.boolean(),
    walking: z.boolean(),
  }),
  bundle: z.object({
    path: z.string().startsWith("/web-react/static/js/"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  observedRequest: z.object({
    blockedBeforeSend: z.literal(true),
    itemCount: z.literal(1),
    sport: z.literal("DEFAULT"),
    changeState: z.literal("CHANGED"),
    fields: z.array(z.string().min(1)).min(1),
  }),
});

export type ProfileWriteContract = z.infer<typeof ProfileWriteContractSchema>;
export type ProfileWriteMethod = ProfileWriteContract["method"];
export type RawProfile = { profile: unknown; zones: unknown };

export type ProfileWriteTransport = {
  request(
    method: ProfileWriteMethod,
    path: string,
    body: unknown
  ): Promise<unknown>;
};

type ProfileWrite = {
  method: ProfileWriteMethod;
  path: string;
  body: Record<string, unknown>[];
  rollback: (after?: RawProfile) => Promise<string[]>;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function walk(
  value: unknown,
  visit: (key: string, item: unknown) => void
): void {
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visit));
    return;
  }
  const item = record(value);
  if (!item) return;
  for (const [key, child] of Object.entries(item)) {
    visit(key, child);
    walk(child, visit);
  }
}

function findNumber(value: unknown, names: RegExp[]): number | null {
  let found: number | null = null;
  walk(value, (key, item) => {
    if (
      found === null &&
      typeof item === "number" &&
      names.some((name) => name.test(key))
    ) {
      found = item;
    }
  });
  return found;
}

function findString(value: unknown, names: RegExp[]): string | null {
  let found: string | null = null;
  walk(value, (key, item) => {
    if (
      found === null &&
      typeof item === "string" &&
      names.some((name) => name.test(key))
    ) {
      found = item;
    }
  });
  return found;
}

function automaticFlags(
  value: unknown,
  path: string,
  output: Record<string, boolean>
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      automaticFlags(item, `${path}/${index}`, output)
    );
    return;
  }
  const item = record(value);
  if (!item) return;
  for (const [key, child] of Object.entries(item)) {
    const childPath = `${path}/${key}`;
    if (typeof child === "boolean" && /auto|detect/i.test(key)) {
      output[childPath] = child;
    }
    automaticFlags(child, childPath, output);
  }
}

function scopeObject(
  value: unknown,
  scope: Scope
): Record<string, unknown> | null {
  const root = record(value);
  const profiles = record(root?.profiles);
  const nested = profiles ? record(profiles[scope]) : null;
  if (nested) return nested;
  if (!Array.isArray(value)) return null;
  return (
    value.map(record).find((item) => {
      const sport = item?.sport;
      return (
        typeof sport === "string" && sport.toLowerCase() === scope.toLowerCase()
      );
    }) ?? null
  );
}

function zoneFloor(item: Record<string, unknown>, zone: number): number | null {
  const direct = Object.entries(item).find(
    ([key, value]) =>
      new RegExp(`^zone${zone}(?:Floor|Low|Minimum|Bottom)$`, "i").test(key) &&
      typeof value === "number"
  )?.[1];
  if (typeof direct === "number") return direct;
  const zones = item.zones;
  return Array.isArray(zones) && typeof zones[zone - 1] === "number"
    ? zones[zone - 1]
    : null;
}

function zoneHigh(item: Record<string, unknown>, zone: number): number | null {
  const direct = Object.entries(item).find(
    ([key, value]) =>
      new RegExp(`^zone${zone}(?:High|Ceiling|Maximum|Top)$`, "i").test(key) &&
      typeof value === "number"
  )?.[1];
  return typeof direct === "number" ? direct : null;
}

function scopeRanges(
  value: unknown,
  scope: Scope,
  fallbackMaximum: number | null
): ZoneRange[] | null {
  const item = scopeObject(value, scope);
  if (!item) return null;
  const floors = [1, 2, 3, 4, 5].map((zone) => zoneFloor(item, zone));
  if (floors.some((floor) => floor === null)) return null;
  const maximum =
    findNumber(item, [/^max(?:imum)?HeartRate(?:Used)?$/i]) ?? fallbackMaximum;
  if (maximum === null) return null;
  return floors.map((floor, index) => ({
    low: floor as number,
    high:
      zoneHigh(item, index + 1) ??
      (index < 4 ? (floors[index + 1] as number) - 1 : maximum),
  }));
}

export function normalizeProfile(raw: RawProfile) {
  const maximumHeartRate = findNumber(raw, [
    /^max(?:imum)?HeartRate(?:Used)?$/i,
  ]);
  const ranges = {
    default: scopeRanges(raw.zones, "default", maximumHeartRate),
    running: scopeRanges(raw.zones, "running", maximumHeartRate),
    walking: scopeRanges(raw.zones, "walking", maximumHeartRate),
  };
  const automaticDetection: Record<string, boolean> = {};
  automaticFlags(raw.profile, "/profile", automaticDetection);
  automaticFlags(raw.zones, "/zones", automaticDetection);
  return {
    maximumHeartRate,
    restingHeartRate: findNumber(raw, [
      /^restingHeartRate(?:Used)?$/i,
      /^restingHr$/i,
    ]),
    lactateThresholdHeartRate: findNumber(raw.profile, [
      /^lactateThresholdHeartRate$/i,
      /^thresholdHeartRate$/i,
    ]),
    calculationBasis: findString(scopeObject(raw.zones, "default") ?? raw, [
      /^trainingMethod$/i,
      /^(?:heartRate)?zone(?:Calculation)?(?:Type|Method|Basis)$/i,
      /^hrZoneCalcType$/i,
    ]),
    zones: {
      default: ranges.default?.map(({ low }) => low) ?? null,
      running: ranges.running?.map(({ low }) => low) ?? null,
      walking: ranges.walking?.map(({ low }) => low) ?? null,
      ranges,
      walkingInheritance: ranges.walking ? "walking-specific" : "default",
    },
    automaticDetection,
  };
}

export function isApprovedCalculationBasis(value: string | null): boolean {
  return (
    value === "HR_RESERVE" ||
    (value !== null && /(?:heart.?rate.?reserve|hrr|custom.?bpm)/i.test(value))
  );
}

function desiredZone(
  base: Record<string, unknown>,
  scope: Scope,
  exists: boolean,
  basis: string
): Record<string, unknown> {
  const output = clone(base);
  output.sport = scope.toUpperCase();
  output.trainingMethod = basis;
  output.maxHeartRateUsed = APPROVED_HR_PROFILE.maximumHeartRate;
  output.restingHeartRateUsed = APPROVED_HR_PROFILE.restingHeartRate;
  output.lactateThresholdHeartRateUsed = null;
  APPROVED_HR_PROFILE.zones.forEach(({ zone, low }) => {
    output[`zone${zone}Floor`] = low;
  });
  output.changeState = exists ? "CHANGED" : "NEW";
  return output;
}

function includedScopes(
  raw: RawProfile,
  contract: ProfileWriteContract
): Scope[] {
  const scopes: Scope[] = ["default"];
  if (!contract.scopes.running) {
    throw new Error("Garmin device does not prove running HR-zone support");
  }
  scopes.push("running");
  if (contract.scopes.walking || scopeObject(raw.zones, "walking")) {
    scopes.push("walking");
  }
  return scopes;
}

function changedBody(
  raw: RawProfile,
  contract: ProfileWriteContract
): Record<string, unknown>[] {
  const defaultZone = scopeObject(raw.zones, "default");
  if (!defaultZone) throw new Error("Garmin default HR profile is missing");
  return includedScopes(raw, contract).map((scope) => {
    const existing = scopeObject(raw.zones, scope);
    return desiredZone(
      existing ?? defaultZone,
      scope,
      Boolean(existing),
      contract.calculationBasisValue
    );
  });
}

function rollbackBody(
  before: RawProfile,
  after: RawProfile | undefined,
  contract: ProfileWriteContract
): Record<string, unknown>[] {
  return includedScopes(before, contract).map((scope) => {
    const original = scopeObject(before.zones, scope);
    if (original) return { ...clone(original), changeState: "CHANGED" };
    const created = after ? scopeObject(after.zones, scope) : null;
    const fallback = scopeObject(before.zones, "default");
    if (!created && !fallback)
      throw new Error(`Cannot build ${scope} rollback payload`);
    return {
      ...clone(created ?? fallback ?? {}),
      sport: scope.toUpperCase(),
      changeState: "DELETED",
    };
  });
}

export function buildProfileWrite(
  transport: ProfileWriteTransport,
  raw: RawProfile,
  inputContract: ProfileWriteContract
): ProfileWrite {
  const contract = ProfileWriteContractSchema.parse(inputContract);
  if (
    normalizeProfile(raw).lactateThresholdHeartRate !==
    APPROVED_HR_PROFILE.lactateThresholdHeartRate
  ) {
    throw new Error(
      "Garmin lactate-threshold HR differs from the approved value; this captured contract cannot update it"
    );
  }
  return {
    method: contract.method,
    path: contract.path,
    body: changedBody(raw, contract),
    rollback: async (after) => {
      try {
        await transport.request(
          contract.method,
          contract.path,
          rollbackBody(raw, after, contract)
        );
        return [];
      } catch (error) {
        return [`${contract.path}: ${errorMessage(error)}`];
      }
    },
  };
}

export function profileRestorableState(raw: RawProfile) {
  return { zones: clone(raw.zones) };
}

function rangeText(ranges: readonly ZoneRange[] | null) {
  return ranges?.map(({ low, high }) => `${low}-${high} bpm`) ?? null;
}

export function buildProfileProposal(
  raw: RawProfile,
  inputContract?: ProfileWriteContract
) {
  const current = normalizeProfile(raw);
  const contract = inputContract
    ? ProfileWriteContractSchema.parse(inputContract)
    : null;
  const proposal = {
    schemaVersion: 1,
    sourceFingerprint: canonicalHash(current),
    contractFingerprint: contract ? canonicalHash(contract) : null,
    target: APPROVED_HR_PROFILE,
    changes: {
      maximumHeartRate: {
        before: current.maximumHeartRate,
        after: APPROVED_HR_PROFILE.maximumHeartRate,
      },
      restingHeartRate: {
        before: current.restingHeartRate,
        after: APPROVED_HR_PROFILE.restingHeartRate,
      },
      lactateThresholdHeartRate: {
        before: current.lactateThresholdHeartRate,
        after: APPROVED_HR_PROFILE.lactateThresholdHeartRate,
      },
      calculationBasis: {
        before: current.calculationBasis,
        after: contract?.calculationBasisValue ?? "HR_RESERVE",
      },
      zones: {
        default: {
          before: rangeText(current.zones.ranges.default),
          after: rangeText(APPROVED_HR_PROFILE.zones),
        },
        running: {
          before: rangeText(current.zones.ranges.running),
          after: contract?.scopes.running
            ? rangeText(APPROVED_HR_PROFILE.zones)
            : null,
        },
        walking: {
          before: rangeText(current.zones.ranges.walking),
          after: contract?.scopes.walking
            ? rangeText(APPROVED_HR_PROFILE.zones)
            : "inherits default",
        },
      },
    },
    automaticDetection: current.automaticDetection,
    preservedAutomaticDetection: true,
    watchSyncRequired: true,
  };
  return {
    proposal,
    canonicalProposal: canonicalJson(proposal),
    hash: canonicalHash(proposal),
  };
}

export async function applyProfileWithRollback(
  transport: ProfileWriteTransport,
  raw: RawProfile,
  contract: ProfileWriteContract
) {
  const write = buildProfileWrite(transport, raw, contract);
  try {
    await transport.request(write.method, write.path, write.body);
  } catch (error) {
    return {
      status: "uncertain",
      error: errorMessage(error),
      completed: [],
      rollback: write.rollback,
    } as const;
  }
  return {
    status: "written",
    completed: [write.path],
    rollback: write.rollback,
  } as const;
}

function rangesMatch(actual: ZoneRange[] | null): boolean {
  return (
    canonicalJson(actual) ===
    canonicalJson(
      APPROVED_HR_PROFILE.zones.map(({ low, high }) => ({ low, high }))
    )
  );
}

function flagsPreserved(
  actual: Record<string, boolean>,
  expected?: Record<string, boolean>
): boolean {
  return (
    !expected ||
    Object.entries(expected).every(([path, value]) => actual[path] === value)
  );
}

export function verifyApprovedProfile(
  raw: RawProfile,
  expectedAutomaticDetection?: Record<string, boolean>
) {
  const current = normalizeProfile(raw);
  const scopeChecks = {
    default: rangesMatch(current.zones.ranges.default),
    running: rangesMatch(current.zones.ranges.running),
    walking: current.zones.ranges.walking
      ? rangesMatch(current.zones.ranges.walking)
      : "inherits-default",
  };
  return {
    verified:
      current.maximumHeartRate === APPROVED_HR_PROFILE.maximumHeartRate &&
      current.restingHeartRate === APPROVED_HR_PROFILE.restingHeartRate &&
      current.lactateThresholdHeartRate ===
        APPROVED_HR_PROFILE.lactateThresholdHeartRate &&
      isApprovedCalculationBasis(current.calculationBasis) &&
      flagsPreserved(current.automaticDetection, expectedAutomaticDetection) &&
      scopeChecks.default === true &&
      scopeChecks.running === true &&
      (scopeChecks.walking === true ||
        scopeChecks.walking === "inherits-default"),
    current,
    scopeChecks,
  };
}
