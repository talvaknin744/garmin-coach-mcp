import { z } from "zod";

import { canonicalHash } from "./safety.js";

const TEMPLATE_VERSION = "2026-08-17.v3";
const NO_TARGET = {
  workoutTargetTypeId: 1,
  workoutTargetTypeKey: "no.target",
} as const;
const LAP = { conditionTypeId: 1, conditionTypeKey: "lap.button" } as const;
const TIME = { conditionTypeId: 2, conditionTypeKey: "time" } as const;
const HR_TARGET = {
  workoutTargetTypeId: 4,
  workoutTargetTypeKey: "heart.rate.zone",
} as const;
const STRENGTH = {
  sportTypeId: 5,
  sportTypeKey: "strength_training",
} as const;

export const TrainingWeekDraftSchema = z.object({
  schemaVersion: z.literal(1),
  templateVersion: z.literal(TEMPLATE_VERSION),
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  weekNumber: z.number().int().min(1).max(6),
  recoveryAction: z.enum(["keep", "reduce", "skip"]),
  healthBlockers: z.array(z.string()),
  evidence: z.object({
    observedAt: z.string().datetime(),
    snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  workouts: z.array(
    z.object({
      sessionKey: z.enum(["pull", "run", "push", "support", "incline-walk"]),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      sport: z.enum(["strength", "running", "treadmill"]),
      marker: z.string(),
      payload: z.record(z.unknown()),
    })
  ),
  warnings: z.array(z.string()),
});

export type TrainingWeekDraft = z.infer<typeof TrainingWeekDraftSchema>;
type WorkoutDraft = TrainingWeekDraft["workouts"][number];
type Step = Record<string, unknown>;

type Exercise = {
  description: string;
  sets?: number;
  restSeconds?: number;
  seconds?: number;
};

type Block =
  Exercise | { superset: Exercise[]; sets: number; restSeconds: number };

const PULL: Block[] = [
  {
    description:
      "Handstand chest-to-wall: 30-40 sec. Locked elbows; push the floor; high shoulders; ribs in; core and glutes tight; legs together; long straight line.",
    sets: 2,
    restSeconds: 120,
    seconds: 40,
  },
  {
    description:
      "Wall detach: 3-5 reps. Gently detach the feet, hold 2-5 sec, and return to the wall under control. Correct through the fingers and palm, not the hips. Rest 60-90 sec. Total handstand work: about 6-8 min.",
    sets: 2,
    restSeconds: 90,
  },
  {
    description:
      "Weighted supinated pull-up: 4-6 reps, RPE 8. Rest 4 min. Increase only after clean 6+6 without kipping or grinding.",
    sets: 2,
    restSeconds: 240,
  },
  {
    description:
      "Explosive high pull: 2-3 reps, RPE 6-7. Perform after the heavy pull-ups. Rest 2.5-3 min. Prioritize speed and consistent height; stop when the pull slows.",
    sets: 2,
    restSeconds: 180,
  },
  {
    description: "Wide row: 6-10 reps, RPE 8-9.",
    sets: 2,
  },
  {
    superset: [
      {
        description: "EZ curl: 8-12 reps. Set 1 RPE 8.5-9; set 2 RPE 9-9.5.",
      },
      { description: "Face pull / rear delt: 12-20 reps, RPE 8-9." },
    ],
    sets: 2,
    restSeconds: 120,
  },
  {
    superset: [
      { description: "Hammer curl: 8-12 reps, RPE 8.5-9." },
      {
        description: "Overhead triceps extension: 10-15 reps, RPE 9.",
      },
    ],
    sets: 2,
    restSeconds: 120,
  },
];

const PUSH: Block[] = [
  {
    description:
      "Handstand chest-to-wall reminder: 20-30 sec. Do not fatigue. Locked elbows; push the floor; high shoulders; ribs in; core and glutes tight; legs together.",
    sets: 1,
    seconds: 30,
  },
  {
    description:
      "Free handstand: 6-10 attempts; 20-40 sec between attempts; total 5-8 min. Use less kick, reach the same entry point, stay calm when balance is found, and make small finger corrections. Goal: several 2-5 sec holds; do not add attempts after poor entries.",
  },
  {
    description:
      "Weighted dip technical single: 1 rep, RPE 6.5-7. Current reference 55-60 kg only; do not prescribe weight. Brace, descend about 1 sec to 90 degrees, drive hard, and lock out. Shoulders down, chest open, forearms vertical, no bounce. It must not feel hard.",
  },
  {
    description:
      "Weighted dip working set: 6-8 reps, RPE 8-9. Descend about 1 sec, no pause, stop at 90 degrees, and drive up hard. Current reference 35 kg x 7 only; do not prescribe weight. Increase after clean 8+8.",
    sets: 2,
  },
  {
    description:
      "Explosive incline press: 3 reps, RPE 5-6. Use a light load, move fast, feel no burn, and stay far from failure.",
    sets: 2,
  },
  {
    description: "Incline chest press: 6-10 reps, RPE 8-9.",
    sets: 2,
    restSeconds: 180,
  },
  {
    description:
      "Bulgarian split squat: 6-10 reps/leg, RPE 8-9. Increase only after stable 10+10.",
    sets: 2,
  },
  {
    superset: [
      {
        description:
          "Lateral raise: 12-20 reps, RPE 9. Lean against the wall, start the hand slightly behind the body, and keep the motion clean.",
      },
      { description: "Rear delt: 12-20 reps, RPE 8.5-9." },
    ],
    sets: 2,
    restSeconds: 120,
  },
  {
    superset: [
      {
        description:
          "Cuban rotation: 15-20 reps, RPE 6-7. Keep it very light for endurance, control, and shoulder health.",
      },
      {
        description:
          "Cable crunch: 10-15 reps. Set 1 RPE 9; set 2 may reach technical failure.",
      },
    ],
    sets: 2,
    restSeconds: 120,
  },
];

const SUPPORT: Block[] = [
  {
    description: "External rotation: 15-20 reps, RPE 6. Keep it very light.",
    sets: 2,
  },
  {
    description:
      "Free handstand: 3-5 attempts only. Remind the nervous system of balance without fatigue before handstand push-ups.",
  },
  {
    description:
      "Handstand push-up: 3-6 reps, RPE 8 at the current approximately 90-degree depth. Do not increase depth yet. Progress 3+3 -> 4+3 -> 4+4 -> 5+4 -> 5+5 -> 6+6, then increase depth instead of adding 8-10 reps.",
    sets: 2,
    restSeconds: 180,
  },
  {
    description:
      "Negative pull-up: 1 rep, 10 sec total, RPE 7-8. Spend 2-3 sec above, 2-3 sec at 90 degrees, then control the remaining descent.",
    sets: 2,
  },
  {
    description:
      "Dip: 5-8 reps, RPE 7-8. Use a relatively light load; practice 90-degree depth, brace, drive hard, and do not pause at the bottom. This is not another heavy dip day.",
    sets: 2,
  },
  {
    description:
      "Romanian deadlift: 8-10 reps, RPE 8-9. Do not increase until balance is stable.",
    sets: 2,
  },
  {
    superset: [
      { description: "Reverse EZ / cable curl: 10-15 reps, RPE 8.5-9." },
      { description: "Triceps pushdown: 10-15 reps, RPE 9." },
    ],
    sets: 2,
    restSeconds: 120,
  },
  {
    superset: [
      { description: "Lateral raise: 12-20 reps, RPE 9." },
      {
        description:
          "Weighted knee raise: 10-15 reps. Set 1 RPE 9; set 2 may reach technical failure.",
      },
    ],
    sets: 2,
    restSeconds: 120,
  },
];

function interval(description: string, seconds?: number): Step {
  return {
    type: "ExecutableStepDTO",
    stepOrder: 0,
    stepType: { stepTypeId: 3, stepTypeKey: "interval" },
    description,
    endCondition: seconds ? TIME : LAP,
    ...(seconds ? { endConditionValue: seconds } : {}),
    targetType: NO_TARGET,
  };
}

function rest(seconds: number): Step {
  return {
    type: "ExecutableStepDTO",
    stepOrder: 0,
    stepType: { stepTypeId: 4, stepTypeKey: "recovery" },
    description: `Rest ${seconds} sec.`,
    endCondition: TIME,
    endConditionValue: seconds,
    targetType: NO_TARGET,
  };
}

function order(steps: Step[]): Step[] {
  return steps.map((step, index) => ({ ...step, stepOrder: index + 1 }));
}

function blockStep(block: Block, deload: boolean): Step {
  if ("superset" in block) {
    const members = block.superset.map((item) => interval(item.description));
    return {
      type: "RepeatGroupDTO",
      stepOrder: 0,
      numberOfIterations: deload ? 1 : block.sets,
      skipLastRestStep: true,
      workoutSteps: order([...members, rest(block.restSeconds)]),
    };
  }
  const sets = deload ? 1 : (block.sets ?? 1);
  const description = deload
    ? block.description
        .replace(/30-40 sec/, "20-25 sec")
        .replace(/20-30 sec/, "15-20 sec")
        .replace(/3-5 attempts/, "2-3 attempts")
        .replace(/6-10 attempts/, "3-5 attempts")
        .replace(/5-8 min/, "3-5 min")
    : block.description;
  const seconds = deload
    ? block.seconds === 40
      ? 25
      : block.seconds === 30
        ? 20
        : block.seconds
    : block.seconds;
  if (sets === 1) return interval(description, seconds);
  return {
    type: "RepeatGroupDTO",
    stepOrder: 0,
    numberOfIterations: sets,
    skipLastRestStep: true,
    workoutSteps: order([
      interval(description, seconds),
      rest(block.restSeconds ?? 120),
    ]),
  };
}

function strengthPayload(name: string, blocks: Block[], deload: boolean) {
  const kept = deload
    ? blocks.filter(
        (block) =>
          "superset" in block ||
          !block.description.startsWith("Negative pull-up")
      )
    : blocks;
  const workoutSteps = order(kept.map((block) => blockStep(block, deload)));
  return {
    workoutName: name,
    sportType: STRENGTH,
    workoutSegments: [{ segmentOrder: 1, sportType: STRENGTH, workoutSteps }],
  };
}

function cardioPayload(
  name: string,
  sportType: { sportTypeId: number; sportTypeKey: string },
  description: string
) {
  return {
    workoutName: name,
    sportType,
    workoutSegments: [
      {
        segmentOrder: 1,
        sportType,
        workoutSteps: [
          {
            type: "ExecutableStepDTO",
            stepOrder: 1,
            stepType: { stepTypeId: 3, stepTypeKey: "interval" },
            description,
            endCondition: LAP,
            targetType: HR_TARGET,
            targetValueOne: 135,
            targetValueTwo: 149,
          },
        ],
      },
    ],
  };
}

function parseSunday(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error("weekStart must be YYYY-MM-DD");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new Error("weekStart must be a real calendar date");
  }
  if (date.getUTCDay() !== 0) throw new Error("weekStart must be Sunday");
  return date;
}

function addDays(sunday: Date, days: number): string {
  const date = new Date(sunday);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function workout(
  sessionKey: WorkoutDraft["sessionKey"],
  date: string,
  sport: WorkoutDraft["sport"],
  payload: Record<string, unknown>
): WorkoutDraft {
  const marker = `[GC:${date}:${sessionKey}]`;
  return {
    sessionKey,
    date,
    sport,
    marker,
    payload: {
      ...payload,
      description: `${marker} ${String(payload.description ?? "")}`.trim(),
    },
  };
}

export function buildTrainingWeek(input: {
  weekStart: string;
  weekNumber: number;
  recoveryAction: "keep" | "reduce" | "skip";
  healthBlockers?: string[];
  evidence: { observedAt: string; snapshotFingerprint: string };
}): TrainingWeekDraft {
  const sunday = parseSunday(input.weekStart);
  if (
    !Number.isInteger(input.weekNumber) ||
    input.weekNumber < 1 ||
    input.weekNumber > 6
  ) {
    throw new Error("weekNumber must be 1-6");
  }
  const deload = input.weekNumber === 6 || input.recoveryAction === "reduce";
  const runDuration = deload ? "20-27 minutes" : "30-40 minutes";
  const walkDuration = deload ? "23-33 minutes" : "35-50 minutes";
  const workouts =
    input.recoveryAction === "skip"
      ? []
      : [
          workout(
            "pull",
            addDays(sunday, 0),
            "strength",
            strengthPayload("Pull", PULL, deload)
          ),
          workout(
            "run",
            addDays(sunday, 1),
            "running",
            cardioPayload(
              "Base Run 135-149 bpm",
              { sportTypeId: 1, sportTypeKey: "running" },
              `Run ${runDuration} at 135-149 bpm. Press Lap within the prescribed duration.`
            )
          ),
          workout(
            "push",
            addDays(sunday, 2),
            "strength",
            strengthPayload("Push", PUSH, deload)
          ),
          workout(
            "support",
            addDays(sunday, 4),
            "strength",
            strengthPayload("Support", SUPPORT, deload)
          ),
          workout(
            "incline-walk",
            addDays(sunday, 5),
            "treadmill",
            cardioPayload(
              "Incline Walk 12%",
              { sportTypeId: 1, sportTypeKey: "running" },
              `Start from the Treadmill activity. Walk ${walkDuration}. Set treadmill incline to 12%. Adjust speed only to stay at 135-149 bpm. Press Lap within the prescribed duration. If heart rate remains above 149 at the minimum safe walking speed, end the session.`
            )
          ),
        ];
  return TrainingWeekDraftSchema.parse({
    schemaVersion: 1,
    templateVersion: TEMPLATE_VERSION,
    weekStart: input.weekStart,
    weekNumber: input.weekNumber,
    recoveryAction: input.recoveryAction,
    healthBlockers: input.healthBlockers ?? [],
    evidence: input.evidence,
    workouts,
    warnings: [
      "Recovery may keep, reduce, or skip sessions; it must never increase load.",
      "Pain, injury, or illness blocks Garmin workout writes.",
      "No warm-up, cooldown, or weight was invented.",
    ],
  });
}

export function getTrainingProgram() {
  return {
    templateVersion: TEMPLATE_VERSION,
    schedule: [
      "Sunday: Pull",
      "Monday: Run",
      "Tuesday: Push",
      "Wednesday: Rest",
      "Thursday: Support",
      "Friday: Incline Walk 12%",
      "Saturday: Rest",
    ],
    weeks: [1, 2, 3, 4, 5, 6].map((week) => ({
      week,
      phase: week === 6 ? "deload" : "build",
    })),
    progression:
      "Weeks 1-5 use the same program. Increase only when all sets are easy at the top of the range. Handstand push-up progression: 3+3 -> 4+3 -> 4+4 -> 5+4 -> 5+5 -> 6+6, then increase depth.",
    deload:
      "Week 6: half the work, shorter handstands, no heavy negative pull-up, one assistance set, and cardio one-third shorter.",
    sessions: { pull: PULL, push: PUSH, support: SUPPORT },
    cardio: {
      monday: "Run 30-40 minutes at 135-149 bpm.",
      friday:
        "Incline walk 35-50 minutes at fixed 12% incline and 135-149 bpm; adjust speed only.",
    },
    fingerprint: canonicalHash({
      templateVersion: TEMPLATE_VERSION,
      pull: PULL,
      push: PUSH,
      support: SUPPORT,
    }),
  };
}
