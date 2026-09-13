import assert from "node:assert/strict";
import test from "node:test";

import { ProfileService } from "../src/profile-service.js";
import type { RawProfile } from "../src/profile.js";

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

test("profile preview is read-only and explains token-mode write restrictions", async () => {
  const service = new ProfileService({ getRawProfile: async () => raw() });
  const preview = await service.preview();
  assert.match(preview.canonicalProposal, /maximumHeartRate/);
  assert.equal(
    preview.warnings.some((warning) =>
      /disabled in token API mode/i.test(warning)
    ),
    true
  );
});

test("profile apply is fail-closed in token API mode", async () => {
  const service = new ProfileService({ getRawProfile: async () => raw() });
  await assert.rejects(service.apply(), /disabled in token API mode/i);
});
