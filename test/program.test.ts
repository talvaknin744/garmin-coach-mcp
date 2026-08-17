import assert from "node:assert/strict";
import test from "node:test";

import { buildTrainingWeek, getTrainingProgram } from "../src/program.js";

const evidence = {
  observedAt: "2026-08-17T00:00:00.000Z",
  snapshotFingerprint: "a".repeat(64),
};

function allSteps(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(allSteps);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(allSteps)];
}

test("program preserves five build weeks and documented deload", () => {
  const program = getTrainingProgram();
  assert.deepEqual(program.schedule, [
    "Sunday: Pull",
    "Monday: Run",
    "Tuesday: Push",
    "Wednesday: Rest",
    "Thursday: Support",
    "Friday: Incline Walk 12%",
    "Saturday: Rest",
  ]);
  assert.deepEqual(
    program.weeks.map((week) => week.phase),
    ["build", "build", "build", "build", "build", "deload"]
  );
  assert.match(JSON.stringify(program), /6\+6.*increase depth/i);
  assert.match(JSON.stringify(program), /increase only.*top.*range/i);
});

test("week uses exact schedule, custom BPM targets, and fixed incline cue", () => {
  const draft = buildTrainingWeek({
    weekStart: "2026-08-23",
    weekNumber: 1,
    recoveryAction: "keep",
    evidence,
  });
  assert.deepEqual(
    draft.workouts.map(({ sessionKey, date }) => [sessionKey, date]),
    [
      ["pull", "2026-08-23"],
      ["run", "2026-08-24"],
      ["push", "2026-08-25"],
      ["support", "2026-08-27"],
      ["incline-walk", "2026-08-28"],
    ]
  );

  for (const key of ["run", "incline-walk"]) {
    const workout = draft.workouts.find(({ sessionKey }) => sessionKey === key);
    assert.ok(workout);
    const target = allSteps(workout.payload).find(
      (step) =>
        (step.targetType as Record<string, unknown> | undefined)
          ?.workoutTargetTypeKey === "heart.rate.zone"
    );
    assert.ok(target);
    assert.equal(target.targetValueOne, 135);
    assert.equal(target.targetValueTwo, 149);
    assert.equal("zoneNumber" in target, false);
    assert.equal(
      (target.endCondition as Record<string, unknown>).conditionTypeKey,
      "lap.button"
    );
    assert.equal(
      (target.endCondition as Record<string, unknown>).conditionTypeId,
      1
    );
  }

  const friday = draft.workouts.find(
    ({ sessionKey }) => sessionKey === "incline-walk"
  );
  assert.ok(friday);
  assert.equal(friday.payload.workoutName, "Incline Walk 12%");
  assert.equal(friday.sport, "treadmill");
  assert.deepEqual(friday.payload.sportType, {
    sportTypeId: 1,
    sportTypeKey: "running",
  });
  assert.match(
    JSON.stringify(friday.payload),
    /Set treadmill incline to 12%\. Adjust speed only to stay at 135-149 bpm\./
  );
  assert.match(
    JSON.stringify(friday.payload),
    /Start from the Treadmill activity/
  );
  assert.match(JSON.stringify(friday.payload), /35-50 minutes/);
  assert.match(JSON.stringify(friday.payload), /end the session/i);
});

test("strength reps use lap completion, preserve ranges, and invent no weight", () => {
  const draft = buildTrainingWeek({
    weekStart: "2026-08-23",
    weekNumber: 1,
    recoveryAction: "keep",
    evidence,
  });
  const strength = draft.workouts.filter(({ sport }) => sport === "strength");
  const serialized = JSON.stringify(strength);
  assert.match(serialized, /Weighted supinated pull-up.*4-6 reps.*RPE 8/i);
  assert.match(serialized, /Bulgarian split squat.*6-10 reps\/leg.*RPE 8-9/i);
  assert.match(serialized, /10 sec/i);
  assert.doesNotMatch(serialized, /weightValue|weightUnit/);

  for (const step of allSteps(strength)) {
    if (
      typeof step.description === "string" &&
      /reps/i.test(step.description)
    ) {
      assert.equal(
        (step.endCondition as Record<string, unknown>).conditionTypeKey,
        "lap.button"
      );
      assert.equal(
        (step.endCondition as Record<string, unknown>).conditionTypeId,
        1
      );
    }
  }
});

test("deload halves strength sets, removes heavy negative, shortens cardio", () => {
  const build = buildTrainingWeek({
    weekStart: "2026-08-23",
    weekNumber: 5,
    recoveryAction: "keep",
    evidence,
  });
  const deload = buildTrainingWeek({
    weekStart: "2026-08-30",
    weekNumber: 6,
    recoveryAction: "keep",
    evidence,
  });
  assert.ok(allSteps(deload.workouts).length < allSteps(build.workouts).length);
  assert.doesNotMatch(JSON.stringify(deload), /Negative pull-up/i);
  assert.match(JSON.stringify(deload), /20-27 minutes/);
  assert.match(JSON.stringify(deload), /23-33 minutes/);
  const handstand = allSteps(deload.workouts).find(
    (step) =>
      typeof step.description === "string" &&
      step.description.includes("Handstand chest-to-wall: 20-25 sec")
  );
  assert.equal(handstand?.endConditionValue, 25);
});

test("marker identity stays stable across template revisions", () => {
  const draft = buildTrainingWeek({
    weekStart: "2026-08-23",
    weekNumber: 1,
    recoveryAction: "keep",
    evidence,
  });
  assert.equal(draft.workouts[0].marker, "[GC:2026-08-23:pull]");
});
