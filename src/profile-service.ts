import {
  LOCAL_PATHS,
  readJsonIfPresent,
  writePrivateJson,
} from "./local-state.js";
import {
  APPROVED_HR_PROFILE,
  applyProfileWithRollback,
  buildProfileProposal,
  normalizeProfile,
  profileRestorableState,
  type ProfileWriteContract,
  type ProfileWriteTransport,
  ProfileWriteContractSchema,
  type RawProfile,
  verifyApprovedProfile,
} from "./profile.js";
import { canonicalHash, canonicalJson, errorMessage } from "./safety.js";
import { withWriteLock } from "./write-lock.js";

type ProfileGarmin = ProfileWriteTransport & {
  getRawProfile(): Promise<RawProfile>;
};

type ContractLoader = () => Promise<ProfileWriteContract | null>;
type RollbackWriter = (value: unknown) => Promise<void>;

function approvedAutomaticFlags(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object") {
    throw new Error("Approved profile proposal shape changed");
  }
  const proposal = value as Record<string, unknown>;
  if (
    proposal.schemaVersion !== 1 ||
    canonicalJson(proposal.target) !== canonicalJson(APPROVED_HR_PROFILE)
  ) {
    throw new Error("Approved profile proposal target changed");
  }
  const flags = proposal.automaticDetection;
  if (!flags || typeof flags !== "object" || Array.isArray(flags)) {
    throw new Error("Approved automatic-detection flags are missing");
  }
  if (Object.values(flags).some((flag) => typeof flag !== "boolean")) {
    throw new Error("Approved automatic-detection flags changed");
  }
  return flags as Record<string, boolean>;
}

export async function loadProfileContract(): Promise<ProfileWriteContract | null> {
  const value = await readJsonIfPresent(LOCAL_PATHS.profileContract);
  return value === null ? null : ProfileWriteContractSchema.parse(value);
}

export class ProfileService {
  constructor(
    private readonly garmin: ProfileGarmin,
    private readonly contractLoader: ContractLoader = loadProfileContract,
    private readonly rollbackWriter: RollbackWriter = (value) =>
      writePrivateJson(LOCAL_PATHS.profileRollback, value)
  ) {}

  async preview() {
    const current = await this.garmin.getRawProfile();
    const contract = await this.contractLoader();
    return {
      ...buildProfileProposal(current, contract ?? undefined),
      warnings: contract
        ? [
            "Automatic-detection flags and unrelated fields remain unchanged.",
            "Garmin/watch sync and visual confirmation are required after apply.",
          ]
        : [
            "Profile writes are locked until pnpm capture:profile-contract records Garmin's unchanged save request.",
          ],
    };
  }

  async apply(canonicalProposal: string, hash: string, confirmed: boolean) {
    return withWriteLock(() =>
      this.applyLocked(canonicalProposal, hash, confirmed)
    );
  }

  private async applyLocked(
    canonicalProposal: string,
    hash: string,
    confirmed: boolean
  ) {
    if (!confirmed) throw new Error("Explicit confirmation is required");
    let approved: unknown;
    try {
      approved = JSON.parse(canonicalProposal);
    } catch {
      throw new Error("Approved profile proposal is not valid JSON");
    }
    if (
      canonicalJson(approved) !== canonicalProposal ||
      canonicalHash(approved) !== hash
    ) {
      throw new Error("Approved profile proposal or hash changed");
    }
    const expectedAutomaticDetection = approvedAutomaticFlags(approved);
    const contract = await this.contractLoader();
    if (!contract) {
      throw new Error(
        "Profile write contract missing; run pnpm capture:profile-contract"
      );
    }
    const current = await this.garmin.getRawProfile();
    const approvedRecord = approved as Record<string, unknown>;
    if (approvedRecord.contractFingerprint !== canonicalHash(contract)) {
      throw new Error("Captured profile contract changed; preview again");
    }
    const alreadyApplied = verifyApprovedProfile(
      current,
      expectedAutomaticDetection
    );
    if (alreadyApplied.verified) {
      return {
        status: "verified",
        completed: [],
        noOp: true,
        verification: alreadyApplied,
        next: "Sync Garmin and visually confirm every zone on the watch.",
      } as const;
    }
    const fresh = buildProfileProposal(current, contract);
    if (fresh.hash !== hash || fresh.canonicalProposal !== canonicalProposal) {
      throw new Error("Profile or captured contract changed; preview again");
    }
    const beforeRestorable = profileRestorableState(current);
    await this.rollbackWriter({
      createdAt: new Date().toISOString(),
      approvedHash: hash,
      before: normalizeProfile(current),
      restorableFingerprint: canonicalHash(beforeRestorable),
    });

    const write = await applyProfileWithRollback(
      this.garmin,
      current,
      contract
    );
    let readBack: RawProfile;
    try {
      readBack = await this.garmin.getRawProfile();
    } catch (error) {
      const rollbackErrors = await write.rollback();
      try {
        const rollbackRead = await this.garmin.getRawProfile();
        const rollbackRestored =
          canonicalHash(profileRestorableState(rollbackRead)) ===
          canonicalHash(beforeRestorable);
        return {
          status:
            rollbackErrors.length || !rollbackRestored
              ? "uncertain"
              : "rolled-back",
          error: `Profile read-back failed: ${errorMessage(error)}`,
          completed: write.completed,
          rollbackErrors,
          rollbackRestored,
        } as const;
      } catch {
        return {
          status: "uncertain",
          error: `Profile read-back failed: ${errorMessage(error)}`,
          completed: write.completed,
          rollbackErrors,
          rollbackRestored: false,
        } as const;
      }
    }
    const verification = verifyApprovedProfile(
      readBack,
      expectedAutomaticDetection
    );
    if (verification.verified) {
      return {
        status: "verified",
        completed: write.completed,
        verification,
        next: "Sync Garmin and visually confirm every zone on the watch.",
      } as const;
    }
    if (
      write.status === "uncertain" &&
      canonicalHash(profileRestorableState(readBack)) ===
        canonicalHash(beforeRestorable)
    ) {
      return {
        status: "rolled-back",
        completed: write.completed,
        rollbackRestored: true,
        originalError: write.error,
      } as const;
    }

    const rollbackErrors = await write.rollback(readBack);
    let afterRollbackRaw: RawProfile;
    try {
      afterRollbackRaw = await this.garmin.getRawProfile();
    } catch {
      return {
        status: "uncertain",
        error: "Profile rollback read-back failed",
        completed: write.completed,
        rollbackErrors,
        rollbackRestored: false,
      } as const;
    }
    const afterRollback = verifyApprovedProfile(
      afterRollbackRaw,
      expectedAutomaticDetection
    );
    const rollbackRestored =
      canonicalHash(profileRestorableState(afterRollbackRaw)) ===
      canonicalHash(beforeRestorable);
    return {
      status:
        rollbackErrors.length || !rollbackRestored
          ? "uncertain"
          : "rolled-back",
      error: "Profile read-back did not match the approved proposal",
      rollbackErrors,
      afterRollback,
      rollbackRestored,
    } as const;
  }
}
