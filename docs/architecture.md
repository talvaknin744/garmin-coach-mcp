# Architecture

```text
ChatGPT / MCP Inspector
          |
   HTTPS POST/GET/DELETE /mcp
          |
Static bearer-token verification
          |
  Streamable HTTP MCP sessions
          |
  six curated, scope-gated tools
          |
 explicit Garmin operation map in GarminAdapter
          |
 impers bearer HTTP + TLS impersonation
          |
    https://connectapi.garmin.com
```

The same `McpServer` can run over local stdio when `MCP_TRANSPORT=stdio` or over Streamable HTTP when `MCP_TRANSPORT=streamable-http`. Local HTTP binds to `127.0.0.1` by default; Render sets `MCP_BIND_HOST=0.0.0.0` for `$PORT`. Streamable HTTP requests with an Origin header must match `MCP_ALLOWED_ORIGINS`. The service has no browser, filesystem state, persistent disk, cookie jar, CSRF state, password, or refresh-token store.

`/healthz` is intentionally unauthenticated for Render health checks. The protected-resource document is public for client discovery. Every `/mcp` request requires the exact `MCP_AUTH_TOKEN` bearer value. The token is compared in constant time, is never logged, and grants the single configured owner both read and write access. The session is bound to the static owner identity, so sessions cannot be reused as another identity.

Read tools require `garmin:read`; the training write requires `garmin:write`. The static bearer grants both internal scopes, and handlers enforce them again. Authentication failures never include the bearer token. Garmin error messages expose only method, mapped path, and status class; response bodies are not returned or logged.

Garmin routes are called through a typed client with an explicit relative-path boundary. It sends `Authorization: Bearer $GARMIN_TOKEN` to the configured HTTPS Garmin API base, uses `impers` for browser-like TLS/HTTP fingerprints, parses JSON/text/empty responses, and supports binary bodies. It does not translate arbitrary browser routes or retry writes. The raw token is read from the environment at request time and is never persisted.

Training proposals are deterministic JSON. The apply path validates the approved hash, health blockers, six-hour snapshot freshness, deterministic markers, existing Garmin state, and final read-back. It creates only missing workouts and never deletes. HR-profile preview remains available, but HR-profile apply is not advertised because the previous browser-captured contract cannot validate a token-only write endpoint. Unsupported operations fail closed rather than falling back to a browser.

Render configuration is in [render.yaml](../render.yaml). Secret values are entered in Render environment settings, not Git. The service is intentionally compatible with Render's free sleep/ephemeral-storage model.
