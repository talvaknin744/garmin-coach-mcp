#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { runAuth } from "./auth.js";
import { captureProfileContract } from "./profile-contract.js";
import { closeRuntime, registerTools } from "./tools.js";

process.umask(0o077);

async function startMcpServer(): Promise<void> {
  const server = new McpServer(
    { name: "garmin-coach-mcp", version: "0.1.0" },
    {
      instructions:
        "Always preview before apply. Pass canonical proposals and hashes unchanged. Profile and training writes need separate user approvals. Never write workouts when pain, injury, or illness is reported. Never increase recovery load or delete Garmin data.",
    }
  );
  registerTools(server);
  process.stdin.resume();
  await server.connect(new StdioServerTransport());
  console.error("garmin-coach-mcp running on local stdio");
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "auth") return runAuth();
  if (command === "capture-profile-contract") return captureProfileContract();
  if (command) throw new Error(`Unknown command: ${command}`);
  return startMcpServer();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void closeRuntime().finally(() => process.exit(0));
  });
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : "Fatal error");
  await closeRuntime();
  process.exitCode = 1;
});
