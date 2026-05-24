/**
 * Scan all WZ issues for unique assignees, reporters, and creators,
 * and write `data/users.json` for hand-editing before migration.
 *
 * Idempotent: re-running merges new accounts without clobbering email
 * or `current` edits already in place.
 *
 * Usage:
 *   PROJECT_KEY=WZ npm run scripts:users
 *
 * Output schema (data/users.json):
 *   {
 *     "<jira account id>": {
 *       "display_name": "Jane Doe",
 *       "email": "jane@wildzebra.com",
 *       "current": true,
 *       "_seen_in": ["assignee","reporter"]
 *     },
 *     ...
 *   }
 *
 * Edit by hand to:
 *  - Fill `email` for accounts where Jira's API hides it (everyone except
 *    you, in GDPR-mode tenants).
 *  - Set `current: false` for former employees so the importer can skip
 *    inviting them but still record assignment in the migrated description.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import axios from 'axios';

loadEnv();

const JIRA_HOST = process.env.JIRA_HOST!;
const JIRA_EMAIL = process.env.JIRA_EMAIL!;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN!;
const PROJECT_KEY = process.env.PROJECT_KEY ?? 'WZ';
const OUTPUT = resolve('data/users.json');

if (!JIRA_HOST || !JIRA_EMAIL || !JIRA_API_TOKEN) {
  console.error('Missing JIRA_HOST / JIRA_EMAIL / JIRA_API_TOKEN in .env');
  process.exit(1);
}

interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string | null;
}

interface UserRecord {
  display_name: string;
  email: string | null;
  current: boolean;
  _seen_in: string[];
}

const jira = axios.create({
  baseURL: `https://${JIRA_HOST}`,
  auth: { username: JIRA_EMAIL, password: JIRA_API_TOKEN },
  headers: { Accept: 'application/json' },
});

async function* paginateIssues() {
  let nextPageToken: string | undefined;
  for (;;) {
    const params: Record<string, string | number> = {
      jql: `project = "${PROJECT_KEY}"`,
      maxResults: 100,
      fields: 'assignee,reporter,creator',
    };
    if (nextPageToken) params.nextPageToken = nextPageToken;
    const { data } = await jira.get('/rest/api/3/search/jql', { params });
    yield data.issues ?? [];
    if (data.isLast || !data.nextPageToken) return;
    nextPageToken = data.nextPageToken;
  }
}

async function main() {
  console.log(`Scanning ${PROJECT_KEY} for users…`);

  const found = new Map<string, { user: JiraUser; roles: Set<string> }>();
  let issueCount = 0;

  for await (const page of paginateIssues()) {
    for (const issue of page) {
      issueCount++;
      for (const role of ['assignee', 'reporter', 'creator'] as const) {
        const u = issue.fields?.[role] as JiraUser | null;
        if (!u?.accountId) continue;
        const existing = found.get(u.accountId);
        if (existing) {
          existing.roles.add(role);
        } else {
          found.set(u.accountId, { user: u, roles: new Set([role]) });
        }
      }
    }
    process.stdout.write(`\r  scanned ${issueCount} issues, ${found.size} unique users`);
  }
  process.stdout.write('\n');

  // Merge into existing file if present.
  const existing: Record<string, UserRecord> = existsSync(OUTPUT)
    ? JSON.parse(readFileSync(OUTPUT, 'utf-8'))
    : {};

  let added = 0;
  let updated = 0;
  for (const [accountId, { user, roles }] of found) {
    const prior = existing[accountId];
    if (prior) {
      // Refresh display_name + roles, preserve hand edits.
      const newRoles = [...new Set([...prior._seen_in, ...roles])].sort();
      const changed =
        prior.display_name !== user.displayName ||
        JSON.stringify(prior._seen_in) !== JSON.stringify(newRoles);
      existing[accountId] = {
        ...prior,
        display_name: user.displayName,
        // Only fill email from Jira if user hasn't already set one and Jira gives one.
        email: prior.email ?? user.emailAddress ?? null,
        _seen_in: newRoles,
      };
      if (changed) updated++;
    } else {
      existing[accountId] = {
        display_name: user.displayName,
        email: user.emailAddress ?? null,
        current: true,
        _seen_in: [...roles].sort(),
      };
      added++;
    }
  }

  // Sort keys for diff stability.
  const sorted = Object.fromEntries(
    Object.entries(existing).sort(([, a], [, b]) =>
      a.display_name.localeCompare(b.display_name),
    ),
  );

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(sorted, null, 2) + '\n');

  const missingEmails = Object.values(sorted).filter(
    (r) => r.current && !r.email,
  ).length;

  console.log(`\nWrote ${OUTPUT}`);
  console.log(`  total users:     ${Object.keys(sorted).length}`);
  console.log(`  added:           ${added}`);
  console.log(`  updated:         ${updated}`);
  console.log(`  current w/o email: ${missingEmails}  ← fill these in by hand`);
}

main().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});