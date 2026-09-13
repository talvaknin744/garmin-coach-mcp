import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerTools } from "./tools.js";

export const SERVER_INSTRUCTIONS =
  "Always preview before apply. Pass canonical proposals and hashes unchanged. Profile and training writes need separate user approvals. Never write workouts when pain, injury, or illness is reported. Never increase recovery load or delete Garmin data.";

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "garmin-coach-mcp", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS }
  );
  registerTools(server);
  return server;
}
