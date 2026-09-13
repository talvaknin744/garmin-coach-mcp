import { buildProfileProposal, type RawProfile } from "./profile.js";

type ProfileGarmin = {
  getRawProfile(): Promise<RawProfile>;
};

const TOKEN_MODE_WRITE_WARNING =
  "HR profile writes are disabled in token API mode until Garmin documents and validates a direct token-backed write endpoint.";

export class ProfileService {
  constructor(private readonly garmin: ProfileGarmin) {}

  async preview() {
    const current = await this.garmin.getRawProfile();
    return {
      ...buildProfileProposal(current),
      warnings: [
        "Automatic-detection flags and unrelated fields remain unchanged in the proposal.",
        "Garmin/watch sync and visual confirmation are required for any manual update.",
        TOKEN_MODE_WRITE_WARNING,
      ],
    };
  }

  async apply(): Promise<never> {
    throw new Error(TOKEN_MODE_WRITE_WARNING);
  }
}
