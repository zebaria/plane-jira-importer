/**
 * Pre-invite all users from data/users.json into the Plane workspace
 * before running the migration. Importer can then resolve every Jira
 * assignee/reporter to a Plane email and assign correctly.
 *
 * Idempotent: skips users already in the workspace and skips emails
 * that already have an outstanding invitation.
 *
 * Usage:
 *   npm run scripts:invite                 # default: invite everyone with an email
 *   DRY_RUN=1 npm run scripts:invite       # show what would be done, don't POST
 *
 * Notes:
 *  - Plane's API will send the standard "you've been invited" email
 *    via the SMTP we configured in god-mode (SES). Former employees
 *    likely bounce; that's fine — the invitation row still lives in
 *    Plane's DB and the importer can match against it.
 *  - Users with `email: null` are skipped with a warning (we have no
 *    way to invite them).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import axios from 'axios';

import { personalToken } from '../src/utils/auth.js';

loadEnv();

const PLANE_HOST = process.env.PLANE_HOST!;
const PLANE_API_KEY = personalToken();
const PLANE_WORKSPACE_SLUG = process.env.PLANE_WORKSPACE_SLUG!;
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const USERS_FILE = resolve(process.env.USERS_FILE ?? 'data/users.json');

if (!PLANE_HOST || !PLANE_WORKSPACE_SLUG) {
  console.error('Missing PLANE_HOST / PLANE_WORKSPACE_SLUG in .env');
  process.exit(1);
}

interface UserRecord {
  display_name: string;
  email: string | null;
  current: boolean;
  _seen_in: string[];
}

/** Plane workspace member roles. 5=guest, 10=viewer, 15=member, 20=admin. */
const ROLE_MEMBER = 15;

const plane = axios.create({
  baseURL: PLANE_HOST,
  headers: { 'X-API-Key': PLANE_API_KEY, Accept: 'application/json' },
});

/**
 * Pull the email field out of a workspace member or invitation
 * record. Plane's API has returned both shapes across versions /
 * endpoints, so accept either:
 *   - flat:   `{ email: "alice@…" }`
 *   - nested: `{ member: { email: "alice@…" } }`
 */
function pickEmail(record: unknown): string | null {
  if (!record || typeof record !== 'object') return null;
  const r = record as { email?: unknown; member?: { email?: unknown } };
  if (typeof r.email === 'string') return r.email;
  if (r.member && typeof r.member === 'object') {
    const me = r.member as { email?: unknown };
    if (typeof me.email === 'string') return me.email;
  }
  return null;
}

/**
 * Plane endpoints sometimes return a flat array and sometimes a
 * paginated `{ results: [...] }`. Normalise to a flat array.
 */
function asArray<T = unknown>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const r = (data as { results?: unknown }).results;
    if (Array.isArray(r)) return r as T[];
  }
  return [];
}

async function main() {
  const users = JSON.parse(readFileSync(USERS_FILE, 'utf-8')) as Record<string, UserRecord>;

  const [{ data: membersData }, { data: invitationsData }] = await Promise.all([
    plane.get(`/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/members/`),
    plane.get(`/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/invitations/`),
  ]);

  const members = asArray(membersData);
  const invitations = asArray(invitationsData);

  const memberEmails = new Set<string>(
    members.map(pickEmail).filter((e): e is string => !!e).map((e) => e.toLowerCase()),
  );
  const invitedEmails = new Set<string>(
    invitations.map(pickEmail).filter((e): e is string => !!e).map((e) => e.toLowerCase()),
  );

  // Dedup by email — multiple Jira accountIds may map to one person.
  const byEmail = new Map<string, UserRecord>();
  let skippedNoEmail = 0;
  for (const u of Object.values(users)) {
    if (!u.email) {
      skippedNoEmail++;
      continue;
    }
    const e = u.email.toLowerCase();
    if (!byEmail.has(e)) byEmail.set(e, u);
  }

  console.log(`Plane workspace: ${PLANE_WORKSPACE_SLUG}`);
  console.log(`Source file:     ${USERS_FILE}`);
  console.log(`Existing members:    ${memberEmails.size}`);
  console.log(`Pending invitations: ${invitedEmails.size}`);
  console.log(`Unique emails in file: ${byEmail.size} (skipped ${skippedNoEmail} with null email)`);
  if (DRY_RUN) console.log('DRY RUN — no API writes');
  console.log();

  let invited = 0;
  let alreadyMember = 0;
  let alreadyInvited = 0;
  let failed = 0;

  for (const [email, u] of byEmail) {
    if (memberEmails.has(email)) {
      alreadyMember++;
      continue;
    }
    if (invitedEmails.has(email)) {
      alreadyInvited++;
      continue;
    }
    const flag = u.current ? '' : ' [former]';
    if (DRY_RUN) {
      console.log(`  would invite: ${email}  (${u.display_name})${flag}`);
      invited++;
      continue;
    }
    try {
      await plane.post(`/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/invitations/`, {
        email,
        role: ROLE_MEMBER,
      });
      console.log(`  invited: ${email}  (${u.display_name})${flag}`);
      invited++;
    } catch (err) {
      const body =
        (err as { response?: { data?: unknown } }).response?.data ??
        (err as Error).message;
      console.error(`  FAILED: ${email}  ${JSON.stringify(body)}`);
      failed++;
    }
  }

  console.log();
  console.log(`Summary:`);
  console.log(`  invited:         ${invited}${DRY_RUN ? ' (dry run)' : ''}`);
  console.log(`  already member:  ${alreadyMember}`);
  console.log(`  already invited: ${alreadyInvited}`);
  console.log(`  no email:        ${skippedNoEmail}`);
  console.log(`  failed:          ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});