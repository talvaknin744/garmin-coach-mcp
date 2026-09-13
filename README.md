# Garmin Coach MCP

Private Garmin coaching tools exposed through local stdio or an Auth0-protected Streamable HTTP MCP service. The deployed service is intended for one owner: Auth0 authenticates the ChatGPT connection and `AUTH0_ALLOWED_SUBJECT` rejects every other user.

The Garmin side uses a raw `GARMIN_TOKEN` from the environment and browserless HTTP through [`impers`](https://github.com/lexiforest/impers), which provides curl-impersonate TLS/HTTP fingerprints. No Playwright, browser profile, cookies, CSRF state, password, or refresh-token persistence is used.

The project preserves the upstream AGPL-3.0 license and attribution in [NOTICE](NOTICE).

## Local setup

Prerequisites: Node.js 20+, pnpm 10.14.0, a Garmin Connect access token, and a synced watch.

```bash
cd /Users/idanvaknin/Desktop/vunlbilits_res/garmin-coach-mcp
pnpm install
pnpm build
GARMIN_TOKEN='…' MCP_TRANSPORT=stdio pnpm start
```

Never commit or print the token. Rotate it manually when Garmin expires or revokes it. For local development, copy [.env.example](.env.example) to a private environment manager and fill in the values without committing the file.

## Render deployment

The repository includes [render.yaml](render.yaml) for a free Node web service. In Render, create the Blueprint from the `render-token-auth` branch, then set the secret and Auth0 environment values in the service settings. Render supplies `PORT`; the server binds to `0.0.0.0` and serves:

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /healthz` | Public | Render health check only |
| `GET /.well-known/oauth-protected-resource` | Public | OAuth resource metadata |
| `POST/GET/DELETE /mcp` | Auth0 bearer token required | Streamable HTTP MCP |

Required Render values:

```text
GARMIN_TOKEN=<raw Garmin access token>
GARMIN_API_BASE_URL=https://connectapi.garmin.com
AUTH0_ISSUER=https://<tenant>.auth0.com/
AUTH0_AUDIENCE=https://<render-host>/mcp
AUTH0_ALLOWED_SUBJECT=<your Auth0 subject>
MCP_PUBLIC_URL=https://<render-host>
MCP_RESOURCE_URL=https://<render-host>/mcp
MCP_TRANSPORT=streamable-http
```

`MCP_RESOURCE_URL` and `AUTH0_AUDIENCE` must be the exact same URL. Configure the Auth0 API with that identifier, RS256 signing, and the `garmin:read` and `garmin:write` scopes. Allow only your Auth0 subject in `AUTH0_ALLOWED_SUBJECT`. Use Auth0 manual registration or CIMD, and paste the exact ChatGPT redirect URI shown during connector setup into Auth0. ChatGPT uses OAuth 2.1 with PKCE; do not add a static customer API key or `MCP_AUTH_TOKEN`.

Render free services sleep when idle and use ephemeral storage. This service intentionally stores no runtime Garmin state or persistent disk data.

## Connect ChatGPT

For local Streamable HTTP testing, use `MCP_TRANSPORT=streamable-http`, `MCP_BIND_HOST=127.0.0.1`, and the local Auth0 values from [.env.example](.env.example). The server accepts only the configured Inspector origins and rejects other browser origins before authentication.

After the Render service is live, add its MCP URL (`https://<render-host>/mcp`) as a custom connector in ChatGPT Developer Mode. Complete the Auth0 OAuth flow and approve the requested scopes. If custom connectors or write actions are unavailable under the account/workspace policy, the service remains protected and correct, but ChatGPT must first enable those capabilities.

Before enabling writes, validate read-only calls with the real token using MCP Inspector and a test ChatGPT conversation. Test direct reads, follow-ups, an expired/invalid token, a non-owner subject, and missing scopes. Keep `apply_training_week` disabled until those checks pass.

## Tools

Only token-backed and explicitly mapped operations are advertised:

| Tool | Scope | Garmin write |
| --- | --- | --- |
| `get_coaching_snapshot` | `garmin:read` | No |
| `get_training_program` | `garmin:read` | No |
| `preview_training_week` | `garmin:read` | No |
| `apply_training_week` | `garmin:write` | Yes, confirmation required |
| `verify_training_week` | `garmin:read` | No |
| `preview_hr_profile_update` | `garmin:read` | No |

The HR-profile write tool is deliberately omitted: the old browser-captured write contract is not valid proof for a token-only client. There is no browser fallback. Training writes remain preview-first, hash-bound, idempotent, and never delete workouts. Pain/injury or illness blocks workout writes.

## Checks

```bash
pnpm test
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
git diff --check
```

The client maps Garmin 401, 403, 429, and 5xx responses to safe messages without response-body or token leakage. JSON, empty, text, and binary responses are handled without logging credentials.

See [spec.md](spec.md) for behavior and [docs/architecture.md](docs/architecture.md) for trust boundaries.

## License

AGPL-3.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
