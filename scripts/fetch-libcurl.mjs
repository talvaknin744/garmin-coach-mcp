// Fetches libcurl-impersonate into .impers-cache at build time so the server
// never depends on a runtime GitHub download. Fails the build if impers would
// fall back to a system libcurl that cannot impersonate a browser.
import { URL, fileURLToPath } from "node:url";

process.env.IMPER_CACHE_DIR ||= fileURLToPath(
  new URL("../.impers-cache", import.meta.url)
);

const { resolveLibrary } = await import("impers");
const library = await resolveLibrary();
if (!library.isImpersonate) {
  process.stderr.write(
    "libcurl-impersonate is unavailable; refusing to fall back to system libcurl\n"
  );
  process.exit(1);
}
process.stdout.write("libcurl-impersonate ready\n");
