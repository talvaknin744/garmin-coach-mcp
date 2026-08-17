import assert from "node:assert/strict";
import test from "node:test";

import { ProfileService } from "../src/profile-service.js";
import type {
  ProfileWriteContract,
  ProfileWriteMethod,
  RawProfile,
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
        sport: "DEFAULT",
        trainingMethod: "LACTATE_THRESHOLD",
        maxHeartRateUsed: 191,
        restingHeartRateUsed: 58,
        lactateThresholdHeartRateUsed: 181,
        zone1Floor: 122,
        zone2Floor: 136,
        zone3Floor: 149,
        zone4Floor: 162,
        zone5Floor: 174,
        restingHrAutoUpdateUsed: true,
        changeState: "UNCHANGED",
      },
    ],
  };
}

class FakeProfileGarmin {
  state = raw();
  writes = 0;
  failReadNumber = 0;
  reads = 0;

  async getRawProfile() {
    this.reads += 1;
    if (this.reads === this.failReadNumber) throw new Error("read failed");
    return structuredClone(this.state);
  }

  async request(method: ProfileWriteMethod, path: string, body: unknown) {
    assert.equal(method, "PUT");
    assert.equal(path, contract.path);
    this.writes += 1;
    const current = this.state.zones as Record<string, unknown>[];
    for (const change of body as Record<string, unknown>[]) {
      const index = current.findIndex(({ sport }) => sport === change.sport);
      if (change.changeState === "DELETED") {
        if (index >= 0) current.splice(index, 1);
      } else if (index >= 0) {
        current[index] = {
          ...structuredClone(change),
          changeState: "UNCHANGED",
        };
      } else {
        current.push({
          ...structuredClone(change),
          serverId: 99,
          changeState: "UNCHANGED",
        });
      }
    }
    return {};
  }
}

test("profile apply retry is a verified no-op", async () => {
  const garmin = new FakeProfileGarmin();
  const service = new ProfileService(
    garmin,
    async () => contract,
    async () => {}
  );
  const preview = await service.preview();
  const first = await service.apply(
    preview.canonicalProposal,
    preview.hash,
    true
  );
  assert.equal(first.status, "verified");
  const writes = garmin.writes;
  const retryPreview = await service.preview();
  const retry = await service.apply(
    retryPreview.canonicalProposal,
    retryPreview.hash,
    true
  );
  assert.equal(retry.status, "verified");
  assert.equal(garmin.writes, writes);
});

test("post-write read failure rolls back and proves restoration", async () => {
  const garmin = new FakeProfileGarmin();
  const service = new ProfileService(
    garmin,
    async () => contract,
    async () => {}
  );
  const preview = await service.preview();
  garmin.failReadNumber = 3;
  const result = await service.apply(
    preview.canonicalProposal,
    preview.hash,
    true
  );
  assert.equal(result.status, "rolled-back");
  assert.equal(garmin.writes, 2);
});
