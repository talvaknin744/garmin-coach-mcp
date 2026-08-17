import assert from "node:assert/strict";
import test from "node:test";

import {
  captureAfterSuccessfulAbort,
  findHeartRateModuleId,
  validateContractCoverage,
  validateUnchangedRequest,
} from "../src/profile-contract.js";
import {
  type ProfileWriteContract,
  ProfileWriteContractSchema,
  type RawProfile,
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

const raw: RawProfile = {
  profile: {},
  zones: [
    {
      sport: "DEFAULT",
      trainingMethod: "HR_RESERVE",
      maxHeartRateUsed: 190,
      restingHeartRateUsed: 55,
      lactateThresholdHeartRateUsed: 181,
      zone1Floor: 100,
      zone2Floor: 120,
      zone3Floor: 140,
      zone4Floor: 160,
      zone5Floor: 180,
    },
  ],
};

test("captured contract requires exact route, method, enum, and bundle hash", () => {
  assert.doesNotThrow(() => validateContractCoverage(contract, raw));
  assert.throws(
    () =>
      ProfileWriteContractSchema.parse({
        ...contract,
        path: "biometric-service/other/",
      }),
    /literal/i
  );
});

test("capture requires default zones and declares exposed walking scope", () => {
  assert.throws(
    () => validateContractCoverage(contract, { profile: {}, zones: [] }),
    /default/i
  );
  const withWalking = structuredClone(raw);
  (withWalking.zones as Record<string, unknown>[]).push({
    ...(withWalking.zones as Record<string, unknown>[])[0],
    sport: "WALKING",
  });
  assert.throws(
    () => validateContractCoverage(contract, withWalking),
    /walking/i
  );
});

test("identifies Garmin's save model, not matching strings alone", () => {
  const bundle =
    '123:(e,t,i)=>{class X{save(){return fetch("/biometric-service/heartRateZones/",{type:"PUT",body:JSON.stringify(this.changedSports)})}}}';
  assert.equal(findHeartRateModuleId(bundle), 123);
  assert.throws(
    () =>
      findHeartRateModuleId(
        '"/biometric-service/heartRateZones/" type:"PUT" JSON.stringify(this.changedSports)'
      ),
    /identified/i
  );
});

test("accepts only an intercepted unchanged default save", () => {
  const item = {
    ...(raw.zones as Record<string, unknown>[])[0],
    changeState: "CHANGED",
  };
  const request = {
    method: "PUT",
    url: "https://connect.garmin.com/gc-api/biometric-service/heartRateZones/",
    postData: JSON.stringify([item]),
  };
  assert.deepEqual(validateUnchangedRequest(request, raw.zones), {
    blockedBeforeSend: true,
    itemCount: 1,
    sport: "DEFAULT",
    changeState: "CHANGED",
    fields: Object.keys(item).sort(),
  });
  assert.throws(
    () =>
      validateUnchangedRequest(
        {
          ...request,
          postData: JSON.stringify([{ ...item, zone2Floor: 121 }]),
        },
        raw.zones
      ),
    /changed/i
  );
  assert.throws(
    () =>
      validateUnchangedRequest(
        { ...request, url: "https://connect.garmin.com/gc-api/other/" },
        raw.zones
      ),
    /route/i
  );
});

test("capture is proven only after abort succeeds", async () => {
  const request = {
    method: "PUT",
    url: "https://connect.garmin.com/gc-api/biometric-service/heartRateZones/",
    postData: "[]",
  };
  let blocked = false;
  assert.equal(
    await captureAfterSuccessfulAbort(request, async () => {
      blocked = true;
    }),
    request
  );
  assert.equal(blocked, true);
  await assert.rejects(
    captureAfterSuccessfulAbort(request, async () => {
      throw new Error("abort failed");
    }),
    /abort failed/
  );
});
