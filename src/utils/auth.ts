/**
 * Token selection helper shared across the scripts/ directory.
 *
 * The migration flow uses two distinct Plane API keys:
 *
 *   - **Personal token** for the bootstrap phase (pulling Jira users
 *     into a JSON, sending invitations, seeding members, and minting
 *     the bot's token itself). These are admin-ish operations the
 *     operator authorises with their own identity.
 *
 *   - **Bot (service-account) token** for the migration phase
 *     (importer, renumber, sprint mapping, image rewrite). Comments
 *     and work items the importer creates get attributed to whichever
 *     User owns the token, so a bot account keeps the migration
 *     visibly distinct from the operator's own activity.
 *
 * The two roles happen to be `PLANE_API_KEY` strings, but they're
 * conceptually different. To avoid the swap-`.env`-mid-flow dance,
 * `.env` can carry both:
 *
 *   PLANE_PERSONAL_API_KEY=plane_api_...   # for steps 1–5
 *   PLANE_BOT_API_KEY=plane_api_...        # for steps 6+
 *
 * Each script imports the helper that matches its role and gets the
 * right token transparently. Falls back to plain `PLANE_API_KEY` if
 * the role-specific one isn't set, so single-token setups still work.
 */

function pick(role: 'personal' | 'bot'): string {
  const specific =
    role === 'personal' ? process.env.PLANE_PERSONAL_API_KEY : process.env.PLANE_BOT_API_KEY;
  const generic = process.env.PLANE_API_KEY;
  const token = specific ?? generic;
  if (!token) {
    const var1 = role === 'personal' ? 'PLANE_PERSONAL_API_KEY' : 'PLANE_BOT_API_KEY';
    console.error(`Missing ${var1} (or PLANE_API_KEY as fallback) in .env`);
    process.exit(1);
  }
  return token;
}

/** Token to use for bootstrap scripts (users, invitations, seeding). */
export const personalToken = (): string => pick('personal');

/** Token to use for the actual migration (importer + post-passes). */
export const botToken = (): string => pick('bot');