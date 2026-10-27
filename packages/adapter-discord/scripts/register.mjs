// Offline only: inspect this guild-scoped registration before manually sending it.
const application = process.env.DISCORD_APPLICATION_ID;
const guild = process.env.DISCORD_REGISTER_GUILD;
if (![application, guild].every((id) => /^\d{17,20}$/.test(id ?? ""))) {
  throw new Error("Set DISCORD_APPLICATION_ID and DISCORD_REGISTER_GUILD to snowflakes");
}
process.stdout.write(
  JSON.stringify(
    {
      method: "POST",
      url: `https://discord.com/api/v10/applications/${application}/guilds/${guild}/commands`,
      body: {
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
      },
    },
    null,
    2,
  ) + "\n",
);
