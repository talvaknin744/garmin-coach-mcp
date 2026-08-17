# Agent rules

- Preserve AGPL-3.0 and upstream attribution.
- Keep the server local and stdio-only. Never add HTTP hosting.
- Ordinary tests are offline. Never create, schedule, edit, or delete Garmin data in tests.
- Never log or return cookies, CSRF tokens, identity, GPS, or raw profile data.
- Do not guess Garmin profile-write routes or payloads. Require an unchanged browser request whose abort succeeded before recording proof.
- Every Garmin write requires explicit confirmation, canonical hash validation, and read-back.
- No workout deletion. Profile and workout approvals stay separate.
- Use pnpm and Zod at external boundaries.
