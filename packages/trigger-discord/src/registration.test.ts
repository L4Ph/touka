import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("offline registration emits a guild-scoped ask command with required bounded prompt and disabled default permissions", () => {
  const result = spawnSync(
    process.execPath,
    [new URL("../scripts/register.mjs", import.meta.url).pathname],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DISCORD_APPLICATION_ID: "111111111111111111",
        DISCORD_REGISTER_GUILD: "222222222222222222",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const registration = JSON.parse(result.stdout);
  assert.equal(
    registration.url,
    "https://discord.com/api/v10/applications/111111111111111111/guilds/222222222222222222/commands",
  );
  assert.equal(registration.method, "POST");
  assert.deepEqual(registration.body, {
    name: "ask",
    description: "Ask the team agent",
    type: 1,
    default_member_permissions: "0",
    options: [
      {
        name: "prompt",
        description: "Task for the agent",
        type: 3,
        required: true,
        max_length: 6000,
      },
    ],
  });
  const invalid = spawnSync(
    process.execPath,
    [new URL("../scripts/register.mjs", import.meta.url).pathname],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DISCORD_APPLICATION_ID: "invalid",
        DISCORD_REGISTER_GUILD: "222222222222222222",
      },
    },
  );
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, "");
});
