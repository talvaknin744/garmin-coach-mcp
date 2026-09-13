# Garmin Coach MCP deployment checklist

- [x] Create the requested checkout and `render-token-auth` branch.
- [x] Replace Playwright, browser profiles, cookies, CSRF, and interactive login with raw `GARMIN_TOKEN` API access.
- [x] Add the explicit Garmin operation map and browserless `impers` transport.
- [x] Add Auth0 JWT verification, owner subject allowlist, OAuth scopes, and protected-resource metadata.
- [x] Add stateful Streamable HTTP `/mcp`, public `/healthz`, and public OAuth discovery.
- [x] Keep local stdio support and preserve preview/hash/confirmation/write-safety behavior.
- [x] Omit the unvalidated HR-profile write tool; do not fall back to a browser.
- [x] Add Render Blueprint, environment example, tests, and deployment documentation.
- [ ] Resolve dependencies with network access and run the complete pnpm gates.
- [ ] Push `render-token-auth` to the user-owned GitHub repository.
- [ ] Create the Render service, enter secrets, configure Auth0, and test through MCP Inspector/ChatGPT.

## Acceptance

- Exactly six validated token API tools are advertised.
- Garmin credentials are read from environment only and are redacted from errors/logs.
- `/mcp` requires Auth0 bearer authentication and the owner subject; health/discovery remain public.
- Read tools require `garmin:read`; the training write requires `garmin:write` and explicit confirmation.
- Ordinary tests never create, schedule, edit, or delete Garmin data.
