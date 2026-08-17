import assert from "node:assert/strict";
import test from "node:test";

import { canonicalHash } from "../src/safety.js";
import {
  TrainingService,
  type GarminWorkoutTransport,
} from "../src/training-service.js";
import { buildTrainingWeek } from "../src/program.js";

class FakeGarmin implements GarminWorkoutTransport {
  workouts: Record<string, unknown>[] = [];
  scheduled = new Map<string, string>();
  creates = 0;
  createDelay = 0;
  normalizeStrength = false;

  async listWorkouts(): Promise<Record<string, unknown>[]> {
    return this.workouts;
  }

  async createWorkout(payload: Record<string, unknown>) {
    if (this.createDelay) {
      await new Promise((resolve) => setTimeout(resolve, this.createDelay));
    }
    this.creates += 1;
    const workout: Record<string, unknown> = {
      ...structuredClone(payload),
      workoutId: this.creates,
    };
    if (
      this.normalizeStrength &&
      (payload.sportType as Record<string, unknown>).sportTypeKey ===
        "strength_training"
    ) {
      let order = 1;
      const normalize = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(normalize);
          return;
        }
        if (!value || typeof value !== "object") return;
        const item = value as Record<string, unknown>;
        if ("stepOrder" in item) item.stepOrder = order++;
        Object.values(item).forEach(normalize);
      };
      normalize(workout.workoutSegments);
    }
    this.workouts.push(workout);
    return workout;
  }

  async scheduleWorkout(workoutId: number, date: string) {
    this.scheduled.set(String(workoutId), date);
    return { workoutId, date };
  }

  async isWorkoutScheduled(workoutId: number, date: string) {
    return this.scheduled.get(String(workoutId)) === date;
  }

  async getWorkoutSchedules(year: number) {
    return [...this.scheduled].flatMap(([workoutId, date]) =>
      date.startsWith(String(year))
        ? [{ workoutId: Number(workoutId), date }]
        : []
    );
  }

  async getWorkout(workoutId: number) {
    const workout = this.workouts.find((item) => item.workoutId === workoutId);
    if (!workout) throw new Error("missing fake workout");
    return workout;
  }
}

function approvedDraft() {
  return buildTrainingWeek({
    weekStart: "2026-08-23",
    weekNumber: 1,
    recoveryAction: "keep",
    evidence: {
      observedAt: new Date().toISOString(),
      snapshotFingerprint: "a".repeat(64),
    },
  });
}

test("apply requires exact hash and rejects health blockers", async () => {
  const garmin = new FakeGarmin();
  const service = new TrainingService(garmin);
  const draft = approvedDraft();
  await assert.rejects(() => service.apply(draft, "wrong", true), /hash/i);
  await assert.rejects(
    () =>
      service.apply(
        { ...draft, healthBlockers: ["illness"] },
        canonicalHash({ ...draft, healthBlockers: ["illness"] }),
        true
      ),
    /health blocker/i
  );
  const stale = {
    ...draft,
    evidence: {
      observedAt: "2020-01-01T00:00:00.000Z",
      snapshotFingerprint: "a".repeat(64),
    },
  };
  await assert.rejects(
    () => service.apply(stale, canonicalHash(stale), true),
    /stale/i
  );
});

test("apply is idempotent and schedules created-but-unscheduled workouts", async () => {
  const garmin = new FakeGarmin();
  const service = new TrainingService(garmin);
  const draft = approvedDraft();
  const hash = canonicalHash(draft);

  const first = await service.apply(draft, hash, true);
  assert.equal(first.created.length, 5);
  assert.equal(first.scheduled.length, 5);

  garmin.scheduled.delete("1");
  const retry = await service.apply(draft, hash, true);
  assert.equal(garmin.creates, 5);
  assert.equal(retry.created.length, 0);
  assert.deepEqual(retry.scheduled, [{ workoutId: 1, date: "2026-08-23" }]);
});

test("accepts Garmin strength step-order normalization", async () => {
  const garmin = new FakeGarmin();
  garmin.normalizeStrength = true;
  const service = new TrainingService(garmin);
  const draft = approvedDraft();
  const result = await service.apply(draft, canonicalHash(draft), true);
  assert.equal(result.status, "verified");
  assert.equal((await service.verify(draft)).verified, true);
});

test("same marker with changed payload is a conflict", async () => {
  const garmin = new FakeGarmin();
  const service = new TrainingService(garmin);
  const draft = approvedDraft();
  await service.apply(draft, canonicalHash(draft), true);
  const first = garmin.workouts[0];
  first.description = `${String(first.description)} changed`;
  await assert.rejects(
    () => service.apply(draft, canonicalHash(draft), true),
    /conflict/i
  );
});

test("all marker and schedule conflicts preflight before writes", async () => {
  const garmin = new FakeGarmin();
  const service = new TrainingService(garmin);
  const draft = approvedDraft();
  garmin.workouts.push({
    ...structuredClone(draft.workouts[1].payload),
    description: `${draft.workouts[1].marker} changed`,
    workoutId: 42,
  });
  await assert.rejects(
    () => service.apply(draft, canonicalHash(draft), true),
    /conflict/i
  );
  assert.equal(garmin.creates, 0);
  assert.equal(garmin.scheduled.size, 0);
});

test("apply rejects missing evidence and preview payload changes", async () => {
  const garmin = new FakeGarmin();
  const service = new TrainingService(garmin);
  const valid = approvedDraft();
  const noEvidence = { ...valid, evidence: undefined };
  await assert.rejects(
    () => service.apply(noEvidence as never, canonicalHash(noEvidence), true),
    /evidence/i
  );
  const changed = structuredClone(valid);
  changed.workouts[0].payload.workoutName = "Arbitrary";
  await assert.rejects(
    () => service.apply(changed, canonicalHash(changed), true),
    /preview/i
  );
});

test("extra read-back step and duplicate marker fail verification", async () => {
  const garmin = new FakeGarmin();
  const service = new TrainingService(garmin);
  const draft = approvedDraft();
  await service.apply(draft, canonicalHash(draft), true);
  const payload = garmin.workouts[0];
  const segments = payload.workoutSegments as Record<string, unknown>[];
  const steps = segments[0].workoutSteps as Record<string, unknown>[];
  steps.push(structuredClone(steps[0]));
  assert.equal((await service.verify(draft)).verified, false);

  garmin.workouts.push({
    ...structuredClone(garmin.workouts[0]),
    workoutId: 99,
  });
  assert.equal((await service.verify(draft)).verified, false);
});

test("wrong-date schedule conflicts instead of scheduling twice", async () => {
  const garmin = new FakeGarmin();
  const service = new TrainingService(garmin);
  const draft = approvedDraft();
  await service.apply(draft, canonicalHash(draft), true);
  garmin.scheduled.set("1", "2026-08-24");
  await assert.rejects(
    () => service.apply(draft, canonicalHash(draft), true),
    /scheduled.*different date/i
  );
});

test("concurrent applies create each workout once", async () => {
  const garmin = new FakeGarmin();
  garmin.createDelay = 5;
  const service = new TrainingService(garmin);
  const draft = approvedDraft();
  const hash = canonicalHash(draft);
  await Promise.all([
    service.apply(draft, hash, true),
    service.apply(draft, hash, true),
  ]);
  assert.equal(garmin.creates, 5);
});
