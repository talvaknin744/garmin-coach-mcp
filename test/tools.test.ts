import assert from "node:assert/strict";
import test from "node:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerTools } from "../src/tools.js";

test("exposes exactly seven curated tools", () => {
  const names: string[] = [];
  const server = {
    registerTool(name: string) {
      names.push(name);
    },
  } as unknown as McpServer;
  registerTools(server);
  assert.deepEqual(names, [
    "get_coaching_snapshot",
    "get_training_program",
    "preview_training_week",
    "apply_training_week",
    "verify_training_week",
    "preview_hr_profile_update",
    "apply_hr_profile_update",
  ]);
});
