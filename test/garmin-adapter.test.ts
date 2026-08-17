import assert from "node:assert/strict";
import test from "node:test";

import { activitySummary } from "../src/garmin-adapter.js";

test("activity summary excludes user-chosen names", () => {
  const summary = activitySummary([
    {
      activityId: 1,
      activityName: "Home to Work",
      activityType: { typeKey: "running" },
      distance: 5000,
    },
  ]);
  assert.equal(JSON.stringify(summary).includes("Home to Work"), false);
  assert.deepEqual(summary, [
    {
      activityId: 1,
      activityType: "running",
      startTimeLocal: undefined,
      duration: undefined,
      distance: 5000,
      averageHR: undefined,
      maxHR: undefined,
      aerobicTrainingEffect: undefined,
      anaerobicTrainingEffect: undefined,
      activityTrainingLoad: undefined,
    },
  ]);
});
