#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { closeHttpServer, startHttpServer } from "./http.js";
import { createMcpServer } from "./mcp-server.js";
import { errorMessage } from "./safety.js";
import { closeRuntime } from "./tools.js";

process.umask(0o077);

async function startStdioServer(): Promise<void> {
  const server = createMcpServer();
  process.stdin.resume();
  await server.connect(new StdioServerTransport());
  console.error("garmin-coach-mcp running on local stdio");
}

async function main(): Promise<void> {
  if (
    process.argv[2] === "http" ||
    process.env.MCP_TRANSPORT === "streamable-http"
  ) {
    await startHttpServer();
    return;
  }
  if (process.argv[2]) throw new Error(`Unknown command: ${process.argv[2]}`);
  await startStdioServer();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void closeHttpServer()
      .catch(() => undefined)
      .finally(() => closeRuntime())
      .finally(() => process.exit(0));
  });
}

main().catch(async (error: unknown) => {
  console.error(errorMessage(error));
  await closeHttpServer().catch(() => undefined);
  await closeRuntime();
  process.exitCode = 1;
});
