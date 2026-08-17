# Architecture

```text
Codex / ChatGPT desktop / Claude
              |
          MCP stdio
              |
      seven curated tools
              |
 preview + SHA-256 approval gates
              |
 Playwright persistent Chromium profile
              |
   browser-originated /gc-api requests
              |
         Garmin Connect
```

The process never listens on a TCP port. `GarminClient` launches a dedicated persistent Chrome profile under `~/.local/share/garmin-coach/browser-profile`. Runtime requests derive CSRF from the current authenticated Garmin page, refresh once on authorization failure, and never persist or log the value. A process lock prevents Codex and Claude from opening or writing through the profile concurrently.

Training proposals are deterministic JSON. The apply path validates the approved hash, health blockers, six-hour snapshot freshness, deterministic markers, existing Garmin state, and final read-back. It creates only missing workouts and never deletes.

Profile writes are fail-closed. The capture command invokes Garmin's current app model with unchanged default zones, intercepts its `PUT`, and records proof only after abort succeeds. It validates the unchanged body and stores only the redacted request shape. Apply clones fresh zone objects, preserves unknown fields and auto flags, creates running zones only when the primary device advertises support, writes a minimal rollback summary, and verifies exact ranges through fresh profile and zone reads.

Workout payloads use Garmin's current workout-type contract. Treadmill is an activity profile beneath Running, so the incline-walk payload uses running workout compatibility and carries an explicit Treadmill launch cue.
