# Garmin Coach MCP

- [x] Verify upstream repository, branch, remote, dirty state, and pin.
- [x] Add offline contract tests.
- [x] Implement dedicated-profile browser client and process lock.
- [x] Implement seven curated MCP tools.
- [x] Implement exact six-week program and custom-BPM workouts.
- [x] Implement profile preview/apply with captured contract and rollback.
- [x] Add setup, security, architecture, and client configuration docs.
- [x] Fix independent review findings and rerun offline tests.
- [x] Verify authenticated Garmin reads.
- [x] Capture and verify current profile-write contract.
- [x] Preview, approve, apply, and verify HR profile.
- [x] Preview, approve, create, schedule, and verify one live week.
- [x] Retry workout apply and prove idempotency; profile retry verified no-op.
- [x] Run final gates.
- [x] Publish GitHub repository and verify remote/CI.

## Acceptance

- Exactly seven tools; only two apply tools write Garmin data.
- Every write needs confirmation, matching canonical proposal/hash, and read-back.
- No cookies, CSRF tokens, identity, GPS, or raw profile data in tool output/logs.
- Monday and Friday use exact `135-149 bpm`; Friday says fixed `12%` incline.
- Weeks 1-5 preserve program; week 6 applies documented deload.
- Ordinary tests make no live Garmin calls.

## Review

HR profile and all five scheduled workouts verify live. Friday uses Running workout compatibility with an explicit Treadmill launch cue. Workout retry created and scheduled nothing. The additional current-week Treadmill session is verified for 2026-08-21.

## Unresolved questions

None.
