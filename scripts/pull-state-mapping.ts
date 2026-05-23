/**
 * Pull distinct Jira statuses used in the source project, list Plane
 * states for the target project, and write `data/state-mapping.json`
 * with auto-matched suggestions.
 *
 * Usage:
 *   PROJECT_KEY=WZ PLANE_PROJECT_ID=<uuid> npm run scripts:states
 *
 * Output schema (data/state-mapping.json):
 *   {
 *     "_plane_states": [
 *       { "name": "Backlog", "id": "...", "group": "backlog" },
 *       ...
 *     ],
 *     "mapping": {
 *       "Done": "Done",
 *       "In Progress": "In Progress",
 *       "Custom State": null   // ← null means unmapped, fill by hand
 *     }
 *   }
 *
 * Re-running merges new Jira statuses without clobbering hand edits.
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

const PLANE_HOST = process.env.PLANE_HOST!;
const PLANE_API_KEY = process.env.PLANE_API_KEY!;
const PLANE_WORKSPACE_SLUG = process.env.PLANE_WORKSPACE_SLUG!;
const PLANE_PROJECT_ID = process.env.PLANE_PROJECT_ID!;

const OUTPUT = resolve('data/state-mapping.json');

if (!JIRA_HOST || !JIRA_EMAIL || !JIRA_API_TOKEN) {
  console.error('Missing JIRA_* in .env');
  process.exit(1);
}
if (!PLANE_HOST || !PLANE_API_KEY || !PLANE_WORKSPACE_SLUG || !PLANE_PROJECT_ID) {
  console.error('Missing PLANE_HOST / PLANE_API_KEY / PLANE_WORKSPACE_SLUG / PLANE_PROJECT_ID in env');
  process.exit(1);
}

const jira = axios.create({
  baseURL: `https://${JIRA_HOST}`,
  auth: { username: JIRA_EMAIL, password: JIRA_API_TOKEN },
  headers: { Accept: 'application/json' },
});

const plane = axios.create({
  baseURL: PLANE_HOST,
  headers: { 'X-API-Key': PLANE_API_KEY, Accept: 'application/json' },
});

interface PlaneState {
  id: string;
  name: string;
  group: string;
}

async function* paginateIssues() {
  let nextPageToken: string | undefined;
  for (;;) {
    const params: Record<string, string | number> = {
      jql: `project = "${PROJECT_KEY}"`,
      maxResults: 100,
      fields: 'status',
    };
    if (nextPageToken) params.nextPageToken = nextPageToken;
    const { data } = await jira.get('/rest/api/3/search/jql', { params });
    yield data.issues ?? [];
    if (data.isLast || !data.nextPageToken) return;
    nextPageToken = data.nextPageToken;
  }
}

function pickPlaneState(jiraName: string, planeStates: PlaneState[]): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
  const target = norm(jiraName);

  // Exact (case/space-insensitive) match
  const exact = planeStates.find((s) => norm(s.name) === target);
  if (exact) return exact.name;

  // Group-based heuristics for common Jira statuses
  const heuristics: Record<string, string> = {
    todo: 'unstarted',
    inprogress: 'started',
    done: 'completed',
    closed: 'completed',
    resolved: 'completed',
    cancelled: 'cancelled',
    canceled: 'cancelled',
    backlog: 'backlog',
    open: 'unstarted',
    new: 'backlog',
    blocked: 'started',
  };
  const wantedGroup = heuristics[target];
  if (wantedGroup) {
    const byGroup = planeStates.find((s) => s.group === wantedGroup);
    if (byGroup) return byGroup.name;
  }

  return null;
}

async function main() {
  console.log(`Scanning ${PROJECT_KEY} for distinct statuses…`);
  const jiraStatuses = new Set<string>();
  let issueCount = 0;
  for await (const page of paginateIssues()) {
    for (const issue of page) {
      const name = issue.fields?.status?.name as string | undefined;
      if (name) jiraStatuses.add(name);
      issueCount++;
    }
    process.stdout.write(`\r  scanned ${issueCount} issues, ${jiraStatuses.size} statuses`);
  }
  process.stdout.write('\n');

  console.log(`Fetching Plane states for project ${PLANE_PROJECT_ID}…`);
  const { data: planeData } = await plane.get(
    `/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/projects/${PLANE_PROJECT_ID}/states/`,
  );
  const planeStates: PlaneState[] = (planeData.results ?? planeData).map(
    (s: { id: string; name: string; group: string }) => ({
      id: s.id,
      name: s.name,
      group: s.group,
    }),
  );

  // Merge with existing edits.
  const existing = existsSync(OUTPUT)
    ? (JSON.parse(readFileSync(OUTPUT, 'utf-8')) as {
        _plane_states: PlaneState[];
        mapping: Record<string, string | null>;
      })
    : { _plane_states: [], mapping: {} };

  const merged: Record<string, string | null> = { ...existing.mapping };

  let added = 0;
  for (const status of [...jiraStatuses].sort()) {
    if (!(status in merged)) {
      merged[status] = pickPlaneState(status, planeStates);
      added++;
    }
  }

  const out = {
    _plane_states: planeStates,
    mapping: Object.fromEntries(Object.entries(merged).sort()),
  };

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(out, null, 2) + '\n');

  const unmapped = Object.entries(merged).filter(([, v]) => !v);

  console.log(`\nWrote ${OUTPUT}`);
  console.log(`  jira statuses:   ${Object.keys(merged).length}`);
  console.log(`  added:           ${added}`);
  console.log(`  plane states:    ${planeStates.length}`);
  console.log(`  unmapped:        ${unmapped.length}`);
  if (unmapped.length > 0) {
    console.log('  fill these in by hand:');
    for (const [k] of unmapped) console.log(`    ${k}`);
  }
}

main().catch((err) => {
  console.error('failed:', err.response?.data ?? err.message);
  process.exit(1);
});