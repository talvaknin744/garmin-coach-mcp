# Garmin Coach MCP specification

## Scope and transports

The server supports local stdio and an Auth0-protected Streamable HTTP endpoint. Local mode is selected with `MCP_TRANSPORT=stdio`; Render uses `MCP_TRANSPORT=streamable-http` and exposes only `/mcp` plus the public health and OAuth discovery routes.

The Garmin credential is a raw `GARMIN_TOKEN` environment variable. No interactive Garmin login, browser profile, cookie/CSRF state, refresh-token persistence, or browser fallback exists.

## HTTP authentication

- `/healthz` is public and returns a minimal healthy response.
- `/.well-known/oauth-protected-resource` is public and advertises the Auth0 issuer, resource URL, and `garmin:read`/`garmin:write` scopes.
- Every `/mcp` request requires an Auth0 JWT with RS256, matching `AUTH0_ISSUER`, `AUTH0_AUDIENCE`/resource, valid time claims, the exact `AUTH0_ALLOWED_SUBJECT`, and the requested scope.
- Missing/invalid bearer tokens return `401` and `WWW-Authenticate` resource metadata. A wrong subject or scope is rejected; sessions cannot be transferred between subjects.
- ChatGPT registration uses OAuth 2.1/PKCE through Auth0. No customer API key or static MCP auth token is supported.

## Tools

Exactly six validated token API tools are advertised:

1. `get_coaching_snapshot` — read recovery, sleep, HRV, Body Battery, resting HR, load, recent activities, HR profile, and freshness.
2. `get_training_program` — read the exact five build weeks and week-six deload program.
3. `preview_training_week` — read current recovery data and build a canonical week without writing.
4. `apply_training_week` — create, schedule, and verify one unchanged approved week; requires a canonical proposal, SHA-256 hash, `confirmed: true`, and `garmin:write`.
5. `verify_training_week` — read Garmin and compare dates, managed steps, targets, descriptions, and IDs.
6. `preview_hr_profile_update` — read current HR settings and return a canonical proposed update without writing.

The HR-profile write tool is omitted. The old browser-captured `PUT` contract is not evidence for a direct token API route, so this operation is fail-closed and has no browser fallback.

## Heart-rate profile proposal

- Maximum: 189 bpm
- Resting: 55 bpm
- Lactate threshold: 181 bpm
- Basis: heart-rate reserve/custom BPM
- Zones: 122-134, 135-149, 150-162, 163-176, 177-189 bpm
- Scopes: default and running; walking-specific when Garmin exposes it, otherwise default inheritance
- Existing automatic-detection flags remain unchanged
- Provenance is provisional: age 27, resting HR 55, estimated max HR 189, manual LTHR 181

## Training

Sunday Pull; Monday 30-40 minute run at 135-149 bpm; Tuesday Push; Wednesday rest; Thursday Support; Friday 35-50 minute fixed 12% incline walk at 135-149 bpm; Saturday rest. Weeks 1-5 repeat. Week 6 halves work, shortens handstands, removes heavy negative pull-ups, uses one assistance set, and shortens cardio by one third.

Cardio uses exact `targetValueOne: 135` and `targetValueTwo: 149`; `zoneNumber` is forbidden. Friday tells the athlete to change speed only and stop if HR remains above 149 at minimum safe walking speed. Garmin models Treadmill as a running activity profile, so Friday uses workout sport `running` and explicitly tells the athlete to launch it from the watch's Treadmill activity.

Writes are marker-based and idempotent. Exact existing workouts are no-ops; unscheduled matches are scheduled; changed payloads conflict; no deletion occurs. Pain/injury or illness blocks workout writes, and recovery can keep, reduce, or skip load but never increase it.
