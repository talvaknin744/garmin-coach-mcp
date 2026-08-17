import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVED_HR_PROFILE,
  applyProfileWithRollback,
  buildProfileProposal,
  buildProfileWrite,
  normalizeProfile,
  type ProfileWriteContract,
  type ProfileWriteTransport,
  type RawProfile,
  verifyApprovedProfile,
} from "../src/profile.js";

const contract: ProfileWriteContract = {
  version: 3,
  capturedAt: "2026-08-17T00:00:00.000Z",
  method: "PUT",
  path: "biometric-service/heartRateZones/",
  payloadType: "changed-sports-array",
  calculationBasisValue: "HR_RESERVE",
  scopes: { default: true, running: true, walking: false },
  bundle: {
    path: "/web-react/static/js/hr.chunk.js",
    sha256: "a".repeat(64),
  },
  observedRequest: {
    blockedBeforeSend: true,
    itemCount: 1,
    sport: "DEFAULT",
    changeState: "CHANGED",
    fields: [
      "changeState",
      "lactateThresholdHeartRateUsed",
      "maxHeartRateUsed",
      "restingHeartRateUsed",
      "sport",
      "trainingMethod",
      "zone1Floor",
      "zone2Floor",
      "zone3Floor",
      "zone4Floor",
      "zone5Floor",
    ],
  },
};

function raw(): RawProfile {
  return {
    profile: {
      userData: {
        lactateThresholdHeartRate: 181,
        thresholdHeartRateAutoDetected: false,
      },
    },
    zones: [
      {
        trainingMethod: "LACTATE_THRESHOLD",
        restingHeartRateUsed: 58,
        lactateThresholdHeartRateUsed: 181,
        zone1Floor: 122,
        zone2Floor: 136,
        zone3Floor: 149,
        zone4Floor: 162,
        zone5Floor: 174,
        maxHeartRateUsed: 191,
        restingHrAutoUpdateUsed: true,
        sport: "DEFAULT",
        changeState: "UNCHANGED",
        unrelated: { keep: true },
      },
    ],
  };
}

function approved(): RawProfile {
  const state = raw();
  const write = buildProfileWrite(
    { request: async () => ({}) },
    state,
    contract
  );
  state.zones = write.body.map((item, index) => ({
    ...item,
    serverId: index + 1,
    changeState: "UNCHANGED",
  }));
  return state;
}

test("approved profile has exact boundaries and provisional provenance", () => {
  assert.deepEqual(APPROVED_HR_PROFILE.zones, [
    { zone: 1, low: 122, high: 134 },
    { zone: 2, low: 135, high: 149 },
    { zone: 3, low: 150, high: 162 },
    { zone: 4, low: 163, high: 176 },
    { zone: 5, low: 177, high: 189 },
  ]);
  assert.equal(APPROVED_HR_PROFILE.provenance.status, "provisional");
});

test("normalizes Garmin's live HR-zone field names and exact ranges", () => {
  const current = normalizeProfile(raw());
  assert.equal(current.maximumHeartRate, 191);
  assert.equal(current.restingHeartRate, 58);
  assert.equal(current.lactateThresholdHeartRate, 181);
  assert.equal(current.calculationBasis, "LACTATE_THRESHOLD");
  assert.deepEqual(current.zones.ranges.default, [
    { low: 122, high: 135 },
    { low: 136, high: 148 },
    { low: 149, high: 161 },
    { low: 162, high: 173 },
    { low: 174, high: 191 },
  ]);
});

test("proposal shows every scope before and after deterministically", () => {
  const first = buildProfileProposal(raw(), contract);
  const second = buildProfileProposal(raw(), contract);
  assert.equal(first.hash, second.hash);
  assert.deepEqual(first.proposal.changes.zones.running.before, null);
  assert.deepEqual(first.proposal.changes.zones.running.after, [
    "122-134 bpm",
    "135-149 bpm",
    "150-162 bpm",
    "163-176 bpm",
    "177-189 bpm",
  ]);
  assert.equal(first.proposal.changes.zones.walking.after, "inherits default");
});

test("unrelated volatile profile fields do not stale an HR approval", () => {
  const first = raw();
  const second = structuredClone(first);
  (second.profile as Record<string, unknown>).lastModified = Date.now();
  assert.equal(
    buildProfileProposal(first, contract).hash,
    buildProfileProposal(second, contract).hash
  );
});

test("write uses Garmin changed-sports payload and preserves unknown fields", () => {
  const write = buildProfileWrite(
    { request: async () => ({}) },
    raw(),
    contract
  );
  assert.equal(write.body.length, 2);
  const [general, running] = write.body;
  assert.equal(general.changeState, "CHANGED");
  assert.equal(general.trainingMethod, "HR_RESERVE");
  assert.equal(general.maxHeartRateUsed, 189);
  assert.equal(general.restingHeartRateUsed, 55);
  assert.equal(general.lactateThresholdHeartRateUsed, null);
  assert.equal(general.zone2Floor, 135);
  assert.deepEqual(general.unrelated, { keep: true });
  assert.equal(running.sport, "RUNNING");
  assert.equal(running.changeState, "NEW");
  assert.equal(running.restingHrAutoUpdateUsed, true);
});

test("verification rejects wrong explicit highs", () => {
  const state = approved();
  assert.equal(verifyApprovedProfile(state).verified, true);
  (state.zones as Record<string, unknown>[])[0].zone1High = 999;
  assert.equal(verifyApprovedProfile(state).verified, false);
});

test("rollback restores default and deletes a newly created running scope", async () => {
  const calls: unknown[] = [];
  const transport: ProfileWriteTransport = {
    request: async (_method, _path, body) => {
      calls.push(body);
      return {};
    },
  };
  const before = raw();
  const write = buildProfileWrite(transport, before, contract);
  await transport.request(write.method, write.path, write.body);
  await write.rollback(approved());
  const rollback = calls[1] as Record<string, unknown>[];
  assert.equal(rollback[0].trainingMethod, "LACTATE_THRESHOLD");
  assert.equal(rollback[0].changeState, "CHANGED");
  assert.equal(rollback[1].sport, "RUNNING");
  assert.equal(rollback[1].changeState, "DELETED");
});

test("request failure is reported as uncertain", async () => {
  const result = await applyProfileWithRollback(
    {
      request: async () => {
        throw new Error("connection lost");
      },
    },
    raw(),
    contract
  );
  assert.equal(result.status, "uncertain");
});
