import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GarminAdapter } from "./garmin-adapter.js";
import { ProfileService } from "./profile-service.js";
import {
  buildTrainingWeek,
  getTrainingProgram,
  TrainingWeekDraftSchema,
} from "./program.js";
import {
  canonicalHash,
  canonicalJson,
  errorMessage,
  redactForOutput,
} from "./safety.js";
import {
  authErrorResult,
  AuthError,
  GARMIN_READ_SCOPE,
  GARMIN_WRITE_SCOPE,
  getAuthConfig,
  requireScope,
} from "./security.js";
import { TrainingService } from "./training-service.js";

const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
    );
  }, "must be a real YYYY-MM-DD date");

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function today(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(redactForOutput(value), null, 2),
      },
    ],
  };
}

function errorResult(error: unknown) {
  if (error instanceof AuthError) {
    return authErrorResult(error, getAuthConfig(undefined, false));
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: errorMessage(error) }],
  };
}

async function result(action: () => Promise<unknown> | unknown) {
  try {
    return jsonResult(await action());
  } catch (error) {
    return errorResult(error);
  }
}

function parseDraft(proposal: string) {
  try {
    return TrainingWeekDraftSchema.parse(JSON.parse(proposal));
  } catch {
    throw new Error("Training proposal is not valid canonical draft JSON");
  }
}

const adapter = new GarminAdapter();
const training = new TrainingService(adapter);
const profile = new ProfileService(adapter);

export function registerTools(server: McpServer): void {
  server.registerTool(
    "get_coaching_snapshot",
    {
      description:
        "Read a privacy-filtered coaching snapshot: recovery, sleep, HRV, Body Battery, resting HR, load, recent activities, HR profile, and freshness.",
      inputSchema: {
        date: DateSchema.optional().describe("YYYY-MM-DD; defaults to today"),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ date }) =>
      result(() => {
        requireScope(GARMIN_READ_SCOPE);
        return adapter.getCoachingSnapshot(date ?? today());
      })
  );

  server.registerTool(
    "get_training_program",
    {
      description:
        "Return the exact five build weeks and week-six deload program.",
      annotations: READ_ANNOTATIONS,
    },
    () =>
      result(() => {
        requireScope(GARMIN_READ_SCOPE);
        return getTrainingProgram();
      })
  );

  server.registerTool(
    "preview_training_week",
    {
      description:
        "Read current recovery data and build a complete canonical week without writing Garmin.",
      inputSchema: {
        weekStart: DateSchema.describe("Sunday in YYYY-MM-DD format"),
        weekNumber: z.number().int().min(1).max(6),
        recoveryAction: z.enum(["keep", "reduce", "skip"]).default("keep"),
        painOrInjury: z.boolean().default(false),
        illness: z.boolean().default(false),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ weekStart, weekNumber, recoveryAction, painOrInjury, illness }) =>
      result(async () => {
        requireScope(GARMIN_READ_SCOPE);
        const snapshot = await adapter.getCoachingSnapshot(today());
        const blockers = [
          ...(painOrInjury ? ["pain-or-injury"] : []),
          ...(illness ? ["illness"] : []),
        ];
        const draft = buildTrainingWeek({
          weekStart,
          weekNumber,
          recoveryAction,
          healthBlockers: blockers,
          evidence: {
            observedAt: snapshot.freshness.observedAt,
            snapshotFingerprint: canonicalHash(snapshot),
          },
        });
        return {
          evidence: snapshot,
          changes: draft.workouts.map(({ sessionKey, date, payload }) => ({
            sessionKey,
            date,
            workoutName: payload.workoutName,
          })),
          warnings: draft.warnings,
          proposal: draft,
          canonicalProposal: canonicalJson(draft),
          hash: canonicalHash(draft),
        };
      })
  );

  server.registerTool(
    "apply_training_week",
    {
      description:
        "Create, schedule, and read back one unchanged approved week. Never deletes workouts.",
      inputSchema: {
        canonicalProposal: z.string().min(1),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        confirmed: z.literal(true),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    ({ canonicalProposal, hash, confirmed }) =>
      result(() => {
        requireScope(GARMIN_WRITE_SCOPE);
        const draft = parseDraft(canonicalProposal);
        if (canonicalJson(draft) !== canonicalProposal) {
          throw new Error(
            "Training proposal changed; use the canonical preview output unchanged"
          );
        }
        return training.apply(draft, hash, confirmed);
      })
  );

  server.registerTool(
    "verify_training_week",
    {
      description:
        "Read Garmin and compare scheduled dates, managed workout steps, targets, descriptions, and IDs.",
      inputSchema: { canonicalProposal: z.string().min(1) },
      annotations: READ_ANNOTATIONS,
    },
    ({ canonicalProposal }) =>
      result(() => {
        requireScope(GARMIN_READ_SCOPE);
        return training.verify(parseDraft(canonicalProposal));
      })
  );

  server.registerTool(
    "preview_hr_profile_update",
    {
      description:
        "Read current HR settings and return every approved before/after field, canonical proposal, and hash. Performs no Garmin writes.",
      annotations: READ_ANNOTATIONS,
    },
    () =>
      result(() => {
        requireScope(GARMIN_READ_SCOPE);
        return profile.preview();
      })
  );
}

export async function closeRuntime(): Promise<void> {
  await adapter.close();
}
