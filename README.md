# Garmin Coach MCP

Private Garmin coaching tools exposed through local stdio or a static-bearer-protected Streamable HTTP MCP service. The deployed service is intended for one owner: a single `MCP_AUTH_TOKEN` protects every `/mcp` request.

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

After building, the smallest live Garmin check is `GARMIN_TOKEN='…' pnpm smoke:garmin`. It calls one read-only allowlisted route and prints only success, route, and response type.

## Render deployment

The repository includes [render.yaml](render.yaml) for a free Node web service. In Render, create the Blueprint from the `render-token-auth` branch, then set the two secrets in the service settings. Render supplies `PORT`; the server binds to `0.0.0.0` and serves:

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /healthz` | Public | Render health check only |
| `GET /.well-known/oauth-protected-resource` | Public | Bearer resource metadata |
| `POST/GET/DELETE /mcp` | Static bearer token required | Streamable HTTP MCP |

Required Render values (Render supplies `RENDER_EXTERNAL_URL`, so the public/resource URLs can stay unset):

```text
GARMIN_TOKEN=<raw Garmin access token>
MCP_AUTH_TOKEN=<long random bearer secret>
GARMIN_API_BASE_URL=https://connectapi.garmin.com
MCP_TRANSPORT=streamable-http
```

Generate `MCP_AUTH_TOKEN` with `openssl rand -hex 32`. Store it only in Render and in the client’s secure bearer-token setting. Rotate it by changing the Render value and updating the client. Do not put either Garmin or MCP secrets in Git.

Render free services sleep when idle and use ephemeral storage. This service intentionally stores no runtime Garmin state or persistent disk data.

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
