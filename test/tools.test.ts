import assert from "node:assert/strict";
import test from "node:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerTools } from "../src/tools.js";

test("exposes exactly six validated token API tools", () => {
  const registrations: {
    name: string;
    options: Record<string, unknown>;
  }[] = [];
  const server = {
    registerTool(name: string, options: Record<string, unknown>) {
      registrations.push({ name, options });
    },
  } as unknown as McpServer;
  registerTools(server);
  assert.deepEqual(
    registrations.map(({ name }) => name),
    [
      "get_coaching_snapshot",
      "get_training_program",
      "preview_training_week",
      "apply_training_week",
      "verify_training_week",
      "preview_hr_profile_update",
    ]
  );
  const writeTool = registrations.find(
    ({ name }) => name === "apply_training_week"
  );
  assert.deepEqual(writeTool?.options.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal(writeTool?.options._meta, undefined);
  assert.equal(
    registrations.some(({ name }) => name === "apply_hr_profile_update"),
    false
  );
});
