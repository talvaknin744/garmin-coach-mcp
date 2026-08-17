# Local Garmin Coach MCP

Private, single-user Garmin coaching tools for Codex/ChatGPT desktop and Claude. The server is local stdio only: no Cloudflare, Render, public URL, account service, or hosting cost.

The runtime is based on [`etweisberg/garmin-connect-mcp`](https://github.com/etweisberg/garmin-connect-mcp) at commit `87d0ea059fb67f1ce65ac05100df74c3c3777c84`. It keeps the upstream AGPL-3.0 license and Taxuspt attribution in [NOTICE](NOTICE).

## Prerequisites

- Node.js 20 or newer
- pnpm 10.14.0
- A Garmin Connect account and synced watch

## Install

```bash
cd /home/talvak/Desktop/repos/garmin-coach-mcp
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build
pnpm auth
```

`pnpm auth` opens a dedicated visible Chrome profile. Log in manually, complete MFA, then press Enter in the terminal. The browser session stays under `~/.local/share/garmin-coach/browser-profile`. Runtime CSRF values are read from the current authenticated page and never persisted or printed. Directories are `0700`, files are `0600`, password saving is disabled, and no username/password file is created.

## Capture Garmin's profile-write contract

Garmin does not publish a stable heart-rate profile write API. The server refuses to guess it.

```bash
pnpm capture:profile-contract
```

The command loads Garmin's current app model, asks it to save the unchanged current default zones, and blocks the resulting `PUT` before delivery. It validates the route and exact unchanged body, then stores only a redacted method/path/field shape and supported scopes in `~/.local/state/garmin-coach/profile-write-contract.json` with mode `0600`.

If Garmin's shape cannot be proven, no contract is saved and profile writes remain disabled.

## Connect Codex and ChatGPT desktop

Build first, then copy [config/codex.toml.example](config/codex.toml.example) into `~/.codex/config.toml`, or add the equivalent server through ChatGPT desktop Settings > MCP servers. Codex CLI, the IDE extension, and ChatGPT desktop share local MCP configuration on the same host.

The example uses:

```toml
default_tools_approval_mode = "writes"
```

Both apply tools also have explicit `approval_mode = "prompt"`. Restart the client after configuration and use `/mcp` to verify connection.

ChatGPT web cannot start this local stdio process. Use ChatGPT desktop/Codex for Garmin writes.

## Connect Claude

Merge [config/claude.json.example](config/claude.json.example) into Claude's MCP configuration, or run:

```bash
claude mcp add garmin-coach -- /home/talvak/snap/code/current/.local/share/pnpm/node /home/talvak/Desktop/repos/garmin-coach-mcp/dist/index.js
```

The filesystem lock permits only one local client to own the Garmin Chromium profile at a time. Stop the server in one client before using the other.

## Tools

| Tool | Garmin write |
| --- | --- |
| `get_coaching_snapshot` | No |
| `get_training_program` | No |
| `preview_training_week` | No |
| `apply_training_week` | Yes, approval required |
| `verify_training_week` | No |
| `preview_hr_profile_update` | No |
| `apply_hr_profile_update` | Yes, separate approval required |

## Safe workflow

1. Call `get_coaching_snapshot` and compare it with Garmin Connect.
2. Call `preview_hr_profile_update`.
3. Review every field and approve the exact canonical proposal/hash.
4. Call `apply_hr_profile_update`; then sync Garmin and visually verify watch zones.
5. Call `preview_training_week` for one Sunday-starting week.
6. Review its recovery evidence, complete payload, warnings, and hash.
7. Call `apply_training_week` with the unchanged canonical proposal/hash.
8. Call `verify_training_week` and confirm Monday/Friday are `135-149 bpm`; Friday must display fixed `12%` instructions.
9. Retry both apply calls to prove idempotency.

Pain/injury or illness blocks workout writes. Recovery can keep, reduce, or skip; it never increases load. Workouts are never deleted automatically.

Garmin exposes Treadmill as a watch activity beneath Running, not as a structured-workout sport. Friday is therefore a running-compatible workout named `Incline Walk 12%`; start it from the watch's Treadmill activity. Its `12%` incline cue and `135-149 bpm` target remain explicit.

## Approved HR profile

| Field | Value |
| --- | --- |
| Maximum HR | 189 bpm |
| Resting HR | 55 bpm |
| Lactate threshold HR | 181 bpm |
| Basis | Heart-rate reserve/custom BPM |
| Zone 1 | 122-134 bpm |
| Zone 2 | 135-149 bpm |
| Zone 3 | 150-162 bpm |
| Zone 4 | 163-176 bpm |
| Zone 5 | 177-189 bpm |

These values are provisional: age 27, resting HR 55, estimated max HR 189, and manual LTHR 181. Automatic-detection flags are preserved. Future changes require another preview and approval.

## Verification

Ordinary tests are offline and never call Garmin:

```bash
pnpm test
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
git diff --check
```

See [spec.md](spec.md) for behavior and [docs/architecture.md](docs/architecture.md) for trust boundaries.

## License

AGPL-3.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
