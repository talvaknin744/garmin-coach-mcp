import { GarminClient } from "../dist/garmin-client.js";
import { errorMessage } from "../dist/safety.js";

const path = "userprofile-service/userprofile/user-settings/";

try {
  const value = await new GarminClient().get(path);
  const responseType =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  process.stdout.write(`${JSON.stringify({ ok: true, path, responseType })}\n`);
} catch (error) {
  process.stderr.write(`Garmin read failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
}
