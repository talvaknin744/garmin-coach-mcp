import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// libcurl-impersonate fetched at build time (scripts/fetch-libcurl.mjs).
// Using it avoids a runtime GitHub download that can fail on cold starts and
// silently fall back to a system libcurl that cannot impersonate a browser.
const bundledCacheDir = fileURLToPath(
  new URL("../.impers-cache", import.meta.url)
);

if (!process.env.IMPER_CACHE_DIR && existsSync(bundledCacheDir)) {
  process.env.IMPER_CACHE_DIR = bundledCacheDir;
}
