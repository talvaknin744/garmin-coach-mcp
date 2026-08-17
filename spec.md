# Garmin Coach MCP specification

## Scope

Single-user local MCP over stdio. Supported clients: Codex/ChatGPT desktop on the same host and Claude. ChatGPT web is outside scope because it cannot start a local stdio process.

## Tools

Exactly seven tools:

1. `get_coaching_snapshot`
2. `get_training_program`
3. `preview_training_week`
4. `apply_training_week`
5. `verify_training_week`
6. `preview_hr_profile_update`
7. `apply_hr_profile_update`

Only the two `apply_*` tools write Garmin data. Both require `confirmed: true`, an unchanged canonical proposal, and its SHA-256 hash.

## Heart-rate profile

- Maximum: 189 bpm
- Resting: 55 bpm
- Lactate threshold: 181 bpm
- Basis: heart-rate reserve/custom BPM
- Zones: 122-134, 135-149, 150-162, 163-176, 177-189 bpm
- Scopes: default and running; walking-specific when Garmin exposes it, otherwise default inheritance
- Existing automatic-detection flags remain unchanged
- Provenance is provisional: age 27, resting HR 55, estimated max 189, manual LTHR 181

Profile apply requires a locally captured unchanged-save request from Garmin's current app model. Capture records proof only after the request abort succeeds, so nothing reaches Garmin, and stores only its redacted shape. Unknown fields are cloned from the latest reads. The single changed-sports write is read back; mismatch or uncertain delivery triggers rollback, and unproven restoration returns `uncertain`.

## Training

Sunday Pull; Monday 30-40 minute run at 135-149 bpm; Tuesday Push; Wednesday rest; Thursday Support; Friday 35-50 minute fixed 12% incline walk at 135-149 bpm; Saturday rest. Weeks 1-5 repeat. Week 6 halves work, shortens handstands, removes heavy negative pull-ups, uses one assistance set, and shortens cardio by one third.

Cardio uses exact `targetValueOne: 135` and `targetValueTwo: 149`; `zoneNumber` is forbidden. Friday tells the athlete to change speed only and stop if HR remains above 149 at minimum safe walking speed. No warm-up, cooldown, or weight is invented.

Garmin models Treadmill as a running activity profile, not a structured-workout sport. Friday therefore uses workout sport `running` and explicitly tells the athlete to launch it from the watch's Treadmill activity.

Writes are marker-based and idempotent. Exact existing workouts are no-ops; unscheduled matches are scheduled; changed payloads conflict; no deletion occurs.

## Privacy and safety

Persistent Chromium profile is local, owner-only, and guarded by one filesystem lock. Password saving is disabled. No username/password file exists. Tool output excludes identity, GPS, session material, and raw profile responses. A pain/injury or illness flag blocks workout writes. Recovery may keep, reduce, or skip load, never increase it.
