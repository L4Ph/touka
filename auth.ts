import { defineAuth } from "void/auth";
import { allowedTeamEmail } from "./shared/team-policy.ts";

export default defineAuth(({ defaults, env }) => ({
  ...defaults,
  // Operators configure social providers; public password registration is never enabled.
  emailAndPassword: { enabled: false },
  account: { accountLinking: { enabled: false } },
  advanced: { ...defaults.advanced, useSecureCookies: true },
  session: { cookieCache: { enabled: false } },
  databaseHooks: {
    user: {
      create: {
        before: async (user) =>
          user.emailVerified && allowedTeamEmail(env.TEAM_EMAILS, user.email)
            ? { data: user }
            : false,
      },
    },
  },
}));
