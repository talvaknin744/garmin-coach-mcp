import { createInterface } from "node:readline/promises";

import { launchGarminContext, waitForGarminSession } from "./garmin-client.js";

export async function runAuth(): Promise<void> {
  const { context, lock } = await launchGarminContext(false);
  const page = context.pages()[0] ?? (await context.newPage());
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    await page.goto("https://connect.garmin.com/app/", {
      waitUntil: "domcontentloaded",
    });
    process.stdout.write(
      "Log in to Garmin Connect in the opened Chromium window, complete MFA, then press Enter here.\n"
    );
    await prompt.question("");
    await waitForGarminSession(page);
    process.stdout.write(
      "Garmin session verified and kept only in the local browser profile.\n"
    );
  } finally {
    prompt.close();
    await context.close().catch(() => undefined);
    await lock.release();
  }
}
