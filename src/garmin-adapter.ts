import type { GarminWorkoutTransport } from "./training-service.js";
import type { RawProfile } from "./profile.js";
import { assertGarminConfig, GarminClient } from "./garmin-client.js";
import { GarminRoutes } from "./garmin-routes.js";
import { normalizeProfile } from "./profile.js";
import { errorMessage, redactForOutput } from "./safety.js";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function array(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(record);
  const source = record(value);
  for (const key of ["workouts", "items", "results"]) {
    if (Array.isArray(source[key]))
      return (source[key] as unknown[]).map(record);
  }
  return [];
}

function metrics(value: unknown, allowed: RegExp): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  function visit(item: unknown): void {
    if (Array.isArray(item)) {
      item.slice(0, 30).forEach(visit);
      return;
    }
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(
      item as Record<string, unknown>
    )) {
      if (
        allowed.test(key) &&
        (typeof child === "string" ||
          typeof child === "number" ||
          typeof child === "boolean" ||
          child === null)
      ) {
        output[key] ??= child;
      }
      visit(child);
    }
  }
  visit(redactForOutput(value));
  return output;
}

export function activitySummary(value: unknown) {
  return array(value)
    .slice(0, 10)
    .map((activity) => ({
      activityId: activity.activityId,
      activityType:
        record(activity.activityType).typeKey ?? activity.activityType,
      startTimeLocal: activity.startTimeLocal,
      duration: activity.duration,
      distance: activity.distance,
      averageHR: activity.averageHR,
      maxHR: activity.maxHR,
      aerobicTrainingEffect: activity.aerobicTrainingEffect,
      anaerobicTrainingEffect: activity.anaerobicTrainingEffect,
      activityTrainingLoad: activity.activityTrainingLoad,
    }));
}

function objectContainsSchedule(
  value: unknown,
  workoutId: number,
  date: string
): boolean {
  if (Array.isArray(value))
    return value.some((item) => objectContainsSchedule(item, workoutId, date));
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const hasWorkoutId = Object.entries(item).some(
    ([key, child]) => /workoutId/i.test(key) && Number(child) === workoutId
  );
  const hasDate = Object.entries(item).some(
    ([key, child]) => /date|start/i.test(key) && String(child).startsWith(date)
  );
  if (hasWorkoutId && hasDate) return true;
  return Object.values(item).some((child) =>
    objectContainsSchedule(child, workoutId, date)
  );
}

function collectSchedules(
  value: unknown,
  output: { workoutId: number; date: string }[]
): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSchedules(item, output));
    return;
  }
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  const workoutId = Object.entries(item).find(
    ([key, child]) =>
      /workoutId/i.test(key) && Number.isSafeInteger(Number(child))
  )?.[1];
  const date = Object.entries(item).find(
    ([key, child]) =>
      /date|start/i.test(key) && /^\d{4}-\d{2}-\d{2}/.test(String(child))
  )?.[1];
  if (workoutId !== undefined && date !== undefined) {
    output.push({
      workoutId: Number(workoutId),
      date: String(date).slice(0, 10),
    });
  }
  Object.values(item).forEach((child) => collectSchedules(child, output));
}

async function settled(name: string, promise: Promise<unknown>) {
  try {
    return { name, status: "ok" as const, data: await promise };
  } catch (error) {
    return { name, status: "unavailable" as const, error: errorMessage(error) };
  }
}

export class GarminAdapter implements GarminWorkoutTransport {
  constructor(private readonly client = new GarminClient()) {}

  async getRawProfile(): Promise<RawProfile> {
    const [profile, zones] = await Promise.all([
      this.client.get(GarminRoutes.profile),
      this.client.get(GarminRoutes.heartRateZones),
    ]);
    return { profile, zones };
  }

  async getCoachingSnapshot(date: string) {
    assertGarminConfig();
    const sources = await Promise.all([
      settled(
        "trainingReadiness",
        this.client.get(GarminRoutes.trainingReadiness(date))
      ),
      settled(
        "trainingLoad",
        this.client.get(GarminRoutes.trainingStatus(date))
      ),
      settled(
        "sleep",
        this.client.get(GarminRoutes.sleep, {
          date,
          nonSleepBufferMinutes: 60,
        })
      ),
      settled("bodyBattery", this.client.get(GarminRoutes.bodyBattery)),
      settled("hrv", this.client.get(GarminRoutes.hrv(date))),
      settled(
        "heartRate",
        this.client.get(GarminRoutes.dailyHeartRate, { date })
      ),
      settled(
        "activities",
        this.client.get(GarminRoutes.activities, {
          start: 0,
          limit: 10,
        })
      ),
      settled("profile", this.getRawProfile()),
    ]);
    const byName = Object.fromEntries(
      sources.map((source) => [source.name, source])
    );
    const data = (name: string) =>
      byName[name]?.status === "ok" ? byName[name].data : null;
    const profile = data("profile") as RawProfile | null;
    return {
      freshness: {
        observedAt: new Date().toISOString(),
        sourceDate: date,
        sources: Object.fromEntries(
          sources.map(({ name, status, ...source }) => [
            name,
            status === "ok" ? { status } : { status, error: source.error },
          ])
        ),
      },
      recovery: metrics(
        data("trainingReadiness"),
        /readiness|recovery|score|level|feedback|timestamp/i
      ),
      sleep: metrics(
        data("sleep"),
        /sleepScore|totalSleep|deepSleep|lightSleep|remSleep|awakeSleep|sleepNeed|startTimestamp|endTimestamp/i
      ),
      hrv: metrics(data("hrv"), /hrv|weeklyAvg|lastNightAvg|status|baseline/i),
      bodyBattery: metrics(
        data("bodyBattery"),
        /bodyBattery|charged|drained|highest|lowest|current/i
      ),
      restingHeartRate: metrics(
        data("heartRate"),
        /restingHeartRate|restingHr/i
      ),
      trainingLoad: metrics(
        data("trainingLoad"),
        /load|acute|chronic|ratio|status|feedback|training/i
      ),
      activities: activitySummary(data("activities")),
      heartRateProfile: profile ? normalizeProfile(profile) : null,
    };
  }

  async listWorkouts(): Promise<Record<string, unknown>[]> {
    const workouts: Record<string, unknown>[] = [];
    for (let start = 0; start < 10_000; start += 100) {
      const page = array(
        await this.client.get(GarminRoutes.workouts, { start, limit: 100 })
      );
      workouts.push(...page);
      if (page.length < 100) break;
      if (start === 9_900)
        throw new Error("Garmin workout list exceeded the safety limit");
    }
    return workouts;
  }

  async createWorkout(payload: Record<string, unknown>) {
    return record(
      await this.client.request("POST", GarminRoutes.workout, payload)
    );
  }

  async scheduleWorkout(workoutId: number, date: string) {
    return this.client.request(
      "POST",
      GarminRoutes.scheduleWorkout(workoutId),
      { date }
    );
  }

  async isWorkoutScheduled(workoutId: number, date: string) {
    const parsed = new Date(`${date}T00:00:00.000Z`);
    const calendar = await this.client.get(
      GarminRoutes.calendar(parsed.getUTCFullYear(), parsed.getUTCMonth())
    );
    return objectContainsSchedule(calendar, workoutId, date);
  }

  async getWorkoutSchedules(year: number) {
    const calendars = await Promise.all(
      Array.from({ length: 12 }, (_, month) =>
        this.client.get(GarminRoutes.calendar(year, month))
      )
    );
    const schedules: { workoutId: number; date: string }[] = [];
    calendars.forEach((calendar) => collectSchedules(calendar, schedules));
    return schedules.filter(
      (schedule, index) =>
        schedules.findIndex(
          (candidate) =>
            candidate.workoutId === schedule.workoutId &&
            candidate.date === schedule.date
        ) === index
    );
  }

  async getWorkout(workoutId: number) {
    return record(
      await this.client.get(`${GarminRoutes.workout}/${workoutId}`)
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
