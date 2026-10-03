# Garmin Coach MCP

Private Garmin coaching tools exposed through local stdio or a static-bearer-protected Streamable HTTP MCP service. The deployed service is intended for one owner: a single `MCP_AUTH_TOKEN` protects every `/mcp` request.

The Garmin side restores an OAuth session from `GARMIN_OAUTH_TOKENS` and uses browserless HTTP through [`impers`](https://github.com/lexiforest/impers), which provides curl-impersonate TLS/HTTP fingerprints. Username and password secrets are kept only as a fallback for a new Garmin SSO login; no Playwright or browser profile is used.

The project preserves the upstream AGPL-3.0 license and attribution in [NOTICE](NOTICE).

## Local setup

Prerequisites: Node.js 20+, pnpm 10.14.0, Garmin Connect credentials, and a synced watch.

```bash
cd /Users/idanvaknin/Desktop/vunlbilits_res/garmin-coach-mcp
pnpm install
pnpm build
node --env-file=.env dist/index.js
```

Copy [.env.example](.env.example) to `.env` and fill in the credentials locally. Never commit or print credentials or OAuth tokens.

After building, the smallest live Garmin check is `pnpm smoke:garmin` with `GARMIN_EMAIL` and `GARMIN_PASSWORD` in the local `.env`. It calls one read-only allowlisted route and prints only success, route, and response type.

## Render deployment

The repository includes [render.yaml](render.yaml) for a free Node web service. In Render, create the Blueprint from the `render-token-auth` branch, then set the listed secrets in the service settings. Render supplies `PORT`; the server binds to `0.0.0.0` and serves:

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /healthz` | Public | Render health check only |
| `GET /.well-known/oauth-protected-resource` | Public | Bearer resource metadata |
| `POST/GET/DELETE /mcp` | Static bearer token required | Streamable HTTP MCP |

Required Render values (Render supplies `RENDER_EXTERNAL_URL`, so the public/resource URLs can stay unset):

```text
GARMIN_EMAIL=<Garmin account email>
GARMIN_PASSWORD=<Garmin account password>
GARMIN_OAUTH_TOKENS=<OAuth token JSON bootstrapped by a local Garmin login>
MCP_AUTH_TOKEN=<long random bearer secret>
GARMIN_API_BASE_URL=https://connectapi.garmin.com
MCP_TRANSPORT=streamable-http
```

`GARMIN_OAUTH_TOKENS` lets Render restore a Garmin OAuth session established from the local machine, avoiding a new password/SSO login at every cold start. The client refreshes expired access tokens while it is running; if Garmin invalidates the underlying OAuth session, it falls back to SSO login. Generate and transfer this value without printing it, and store it only in Render's secret settings and the local `.env`. Generate `MCP_AUTH_TOKEN` with `openssl rand -hex 32`. Store it only in Render and in the client's secure bearer-token setting. Rotate it by changing the Render value and updating the client. Do not put any Garmin or MCP secrets in Git.

Render free services sleep when idle and use ephemeral storage. This service intentionally stores no runtime Garmin state or persistent disk data.

The Render start command is `node dist/index.js http`, equivalent to `pnpm start:http` without invoking Corepack or downloading pnpm during a cold start. pnpm remains part of the build command. This removes package-manager startup overhead; it does not eliminate Render's free-service wake-up delay.

For an existing service, a Git push applies `render.yaml` settings only when the service is managed by a Blueprint that syncs this branch. If Blueprint Auto Sync is disabled, manually sync the Blueprint. If the service is not Blueprint-managed, set its Start Command to `node dist/index.js http` and redeploy; an ordinary code auto-deploy does not update that setting from this file. See [Render's Blueprint sync documentation](https://render.com/docs/infrastructure-as-code#disabling-automatic-sync).

## Connect ChatGPT

For local Streamable HTTP testing, use `MCP_TRANSPORT=streamable-http`, `MCP_BIND_HOST=127.0.0.1`, and `MCP_AUTH_TOKEN` from [.env.example](.env.example). The server accepts only the configured Inspector origins and rejects other browser origins before authentication.

The static bearer can be used with MCP Inspector, curl, or another MCP client that lets you set `Authorization: Bearer ...`. OpenAI’s documented ChatGPT custom-MCP flow expects OAuth 2.1, so this mode may not be accepted by ChatGPT’s connector UI. If the UI has a custom bearer/header option in your account, use the Render MCP URL and configure the same bearer value; otherwise an OAuth provider is required for ChatGPT access.

Before enabling writes, validate read-only calls with the real Garmin token using MCP Inspector. Test direct reads, follow-ups, an invalid MCP token, and missing authorization. Keep `apply_training_week` disabled until those checks pass.

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
