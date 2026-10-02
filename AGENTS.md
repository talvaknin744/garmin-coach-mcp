# Agent rules

- Preserve AGPL-3.0 and upstream attribution.
- Support local stdio and Auth0-protected Streamable HTTP. Never add an unauthenticated Garmin HTTP surface.
- Ordinary tests are offline. Never create, schedule, edit, or delete Garmin data in tests.
- Never log or return bearer tokens, cookies, CSRF tokens, identity, GPS, or raw profile data.
- Use an explicit Garmin operation map. Do not guess unsupported routes or add a browser fallback.
- Every Garmin write requires explicit confirmation, canonical hash validation, and read-back.
- No workout deletion. Profile and workout approvals stay separate.
- Read Garmin credentials only from `GARMIN_EMAIL` and `GARMIN_PASSWORD` secrets. Keep access/refresh tokens in memory only; never persist or print credentials or tokens.
- Use pnpm and Zod at external boundaries.
