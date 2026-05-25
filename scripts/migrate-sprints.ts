/**
 * Migrate Jira sprints to Plane modules (and cycles, when applicable).
 *
 * Run AFTER the main importer has migrated all issues.
 *
 * Mapping rule (from real-world experience: Plane refuses writes on
 * already-completed cycles, so closed sprints don't translate cleanly):
 *
 *   - Jira sprint with `endDate` in the FUTURE       → Plane Cycle
 *     (it's still an active iteration; cycle UI for burndown etc. makes sense)
 *
 *   - Jira sprint with `endDate` in the PAST or no
 *     dates at all                                   → Plane Module
 *     (Plane modules are the no-time-bound grouping concept; status
 *     field tracks completion: planned / in-progress / completed /
 *     cancelled / paused. We set:
 *       - completed if endDate < now
 *       - planned   otherwise (no dates, or future date with `state=future`)
 *     )
 *
 * Idempotent. Cycles + modules are matched by
 * `external_id = <jira sprint id>` and `external_source = jira-importer`,
 * so re-runs reuse existing rows.
 *
 * Cleanup mode: pass --delete-orphan-cycles to delete cycles created
 * by a previous run that should have been modules. They're matched by
 * external_source=jira-importer; only deletes empty completed cycles.
 *
 * Usage:
 *   npm run scripts:sprints -- \
 *     --project-key WZ --plane-project <uuid>
 *
 *   npm run scripts:sprints -- \
 *     --project-key WZ --plane-project <uuid> --delete-orphan-cycles
 *
 * Reads JIRA_*, PLANE_HOST, PLANE_API_KEY, PLANE_WORKSPACE_SLUG from .env.
 */

import { config as loadEnv } from 'dotenv';
import axios from 'axios';
import type { AxiosError } from 'axios';

loadEnv();

const flags = parseArgs(process.argv.slice(2));
const PROJECT_KEY = flags['project-key'] ?? process.env.PROJECT_KEY ?? 'WZ';
const PLANE_PROJECT_ID = flags['plane-project'] ?? process.env.PLANE_PROJECT_ID;
const DELETE_ORPHAN_CYCLES = flags['delete-orphan-cycles'] === 'true';

const JIRA_HOST = required('JIRA_HOST');
const JIRA_EMAIL = required('JIRA_EMAIL');
const JIRA_API_TOKEN = required('JIRA_API_TOKEN');
const PLANE_HOST = required('PLANE_HOST');
const PLANE_API_KEY = required('PLANE_API_KEY');
const PLANE_WORKSPACE_SLUG = required('PLANE_WORKSPACE_SLUG');

if (!PLANE_PROJECT_ID) {
  console.error('Missing --plane-project <uuid> (or PLANE_PROJECT_ID env)');
  process.exit(1);
}

const SPRINT_FIELD = process.env.JIRA_SPRINT_FIELD ?? 'customfield_10020';
const EXTERNAL_SOURCE = 'jira-importer';

const jira = axios.create({
  baseURL: `https://${JIRA_HOST}`,
  auth: { username: JIRA_EMAIL, password: JIRA_API_TOKEN },
  headers: { Accept: 'application/json' },
});

const plane = axios.create({
  baseURL: PLANE_HOST,
  headers: { 'X-API-Key': PLANE_API_KEY, Accept: 'application/json' },
});

interface JiraSprint {
  id: number;
  name: string;
  state: 'closed' | 'active' | 'future' | string;
  startDate?: string;
  endDate?: string;
  goal?: string;
}

interface PlaneCycle {
  id: string;
  name: string;
  external_id: string | null;
  external_source: string | null;
  start_date: string | null;
  end_date: string | null;
}

interface PlaneModule {
  id: string;
  name: string;
  external_id: string | null;
  external_source: string | null;
  start_date: string | null;
  target_date: string | null;
  status: string;
}

interface PlaneIssue {
  id: string;
  external_id: string | null;
  external_source: string | null;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function isoDate(s?: string): string | undefined {
  if (!s) return undefined;
  // Plane wants YYYY-MM-DD; trim ISO to date-only to dodge tz drift.
  return s.slice(0, 10);
}

/** Decide which side of the cycle/module split a sprint belongs on. */
function classify(sprint: JiraSprint): 'cycle' | 'module' {
  if (!sprint.endDate) return 'module';
  const endMs = Date.parse(sprint.endDate);
  if (Number.isNaN(endMs)) return 'module';
  return endMs > Date.now() ? 'cycle' : 'module';
}

/** Pick a Plane Module status from a Jira sprint. */
function moduleStatus(sprint: JiraSprint): string {
  if (!sprint.endDate) return 'planned'; // no dates → bucket / parking lot
  const endMs = Date.parse(sprint.endDate);
  if (!Number.isNaN(endMs) && endMs < Date.now()) return 'completed';
  return sprint.state === 'active' ? 'in-progress' : 'planned';
}

/** Walk every Jira issue's sprint field via cursor pagination. */
async function* iterateJiraSprintAssignments(): AsyncGenerator<{
  issueKey: string;
  sprints: JiraSprint[];
}> {
  let nextPageToken: string | undefined;
  for (;;) {
    const params: Record<string, string | number> = {
      jql: `project = "${PROJECT_KEY}" AND sprint is not EMPTY`,
      maxResults: 100,
      fields: SPRINT_FIELD,
    };
    if (nextPageToken) params.nextPageToken = nextPageToken;
    const { data } = await jira.get('/rest/api/3/search/jql', { params });
    for (const issue of data.issues ?? []) {
      const sprintList = (issue.fields?.[SPRINT_FIELD] ?? []) as JiraSprint[];
      yield { issueKey: issue.key, sprints: sprintList };
    }
    if (data.isLast || !data.nextPageToken) return;
    nextPageToken = data.nextPageToken;
  }
}

/**
 * Pull every sprint that exists on the Jira board (including ones with
 * no issues). Without this we'd miss empty buckets like `WZ 26 EOY`
 * that the team set up but hasn't filled yet.
 */
async function listJiraSprintsOnBoard(): Promise<JiraSprint[]> {
  // Find the board for this project.
  const { data: boards } = await jira.get('/rest/agile/1.0/board', {
    params: { projectKeyOrId: PROJECT_KEY },
  });
  const sprints: JiraSprint[] = [];
  for (const b of boards.values ?? []) {
    let startAt = 0;
    for (;;) {
      const { data } = await jira.get(`/rest/agile/1.0/board/${b.id}/sprint`, {
        params: { maxResults: 100, startAt, state: 'active,closed,future' },
      });
      for (const s of data.values ?? []) sprints.push(s);
      if (data.isLast || !(data.values ?? []).length) break;
      startAt += data.values.length;
    }
  }
  return sprints;
}

async function listPlaneCycles(): Promise<PlaneCycle[]> {
  const out: PlaneCycle[] = [];
  let cursor: string | undefined;
  for (;;) {
    const { data } = await plane.get(
      `/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/projects/${PLANE_PROJECT_ID}/cycles/`,
      { params: cursor ? { cursor, per_page: 100 } : { per_page: 100 } },
    );
    for (const c of data.results ?? []) out.push(c);
    if (data.next_page_results && data.next_cursor) cursor = data.next_cursor;
    else return out;
  }
}

async function listPlaneModules(): Promise<PlaneModule[]> {
  const out: PlaneModule[] = [];
  let cursor: string | undefined;
  for (;;) {
    const { data } = await plane.get(
      `/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/projects/${PLANE_PROJECT_ID}/modules/`,
      { params: cursor ? { cursor, per_page: 100 } : { per_page: 100 } },
    );
    for (const m of data.results ?? []) out.push(m);
    if (data.next_page_results && data.next_cursor) cursor = data.next_cursor;
    else return out;
  }
}

async function listPlaneIssuesByJiraKey(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let cursor: string | undefined;
  for (;;) {
    const { data } = await plane.get(
      `/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/projects/${PLANE_PROJECT_ID}/issues/`,
      { params: cursor ? { cursor, per_page: 100 } : { per_page: 100 } },
    );
    for (const i of (data.results ?? []) as PlaneIssue[]) {
      if (i.external_source === EXTERNAL_SOURCE && i.external_id) {
        out.set(i.external_id, i.id);
      }
    }
    if (data.next_page_results && data.next_cursor) cursor = data.next_cursor;
    else return out;
  }
}

/** Plane disables cycle/module views on new projects by default. */
async function ensureViewsEnabled(): Promise<void> {
  const { data } = await plane.get<{ cycle_view?: boolean; module_view?: boolean }>(
    `/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/projects/${PLANE_PROJECT_ID}/`,
  );
  const patch: Record<string, boolean> = {};
  if (!data.cycle_view) patch.cycle_view = true;
  if (!data.module_view) patch.module_view = true;
  if (Object.keys(patch).length === 0) return;
  console.log(`  enabling: ${Object.keys(patch).join(', ')}`);
  await plane.patch(
    `/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/projects/${PLANE_PROJECT_ID}/`,
    patch,
  );
}

async function ensureModule(
  sprint: JiraSprint,
  byExtId: Map<string, PlaneModule>,
): Promise<PlaneModule> {
  const extId = String(sprint.id);
  const existing = byExtId.get(extId);
  if (existing) return existing;

  const start = isoDate(sprint.startDate);
  const target = isoDate(sprint.endDate);
  const status = moduleStatus(sprint);

  const payload: Record<string, unknown> = {
    name: sprint.name,
    description: sprint.goal ?? '',
    project_id: PLANE_PROJECT_ID,
    external_id: extId,
    external_source: EXTERNAL_SOURCE,
    status,
  };
  if (start) payload.start_date = start;
  if (target) payload.target_date = target;

  const { data } = await plane.post<PlaneModule>(
    `/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/projects/${PLANE_PROJECT_ID}/modules/`,
    payload,
  );
  console.log(
    `  module: ${sprint.name} (${start ?? '—'} → ${target ?? '—'}, status=${status}) → ${data.id}`,
  );
  byExtId.set(extId, data);
  return data;
}

async function ensureCycle(
  sprint: JiraSprint,
  byExtId: Map<string, PlaneCycle>,
): Promise<PlaneCycle> {
  const extId = String(sprint.id);
  const existing = byExtId.get(extId);
  if (existing) return existing;

  const start = isoDate(sprint.startDate);
  const end = isoDate(sprint.endDate);
  if (!start || !end) {
    throw new Error(`Cycle classification requires start+end (sprint ${sprint.id})`);
  }

  const { data } = await plane.post<PlaneCycle>(
    `/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/projects/${PLANE_PROJECT_ID}/cycles/`,
    {
      name: sprint.name,
      description: sprint.goal ?? '',
      start_date: start,
      end_date: end,
      project_id: PLANE_PROJECT_ID,
      external_id: extId,
      external_source: EXTERNAL_SOURCE,
    },
  );
  console.log(`  cycle:  ${sprint.name} (${start} → ${end}) → ${data.id}`);
  byExtId.set(extId, data);
  return data;
}

async function addIssuesToModule(moduleId: string, workItemIds: string[]): Promise<void> {
  if (workItemIds.length === 0) return;
  // Plane caps payload size; chunk to be safe.
  const CHUNK = 100;
  for (let i = 0; i < workItemIds.length; i += CHUNK) {
    await plane.post(
      `/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/projects/${PLANE_PROJECT_ID}/modules/${moduleId}/module-issues/`,
      { issues: workItemIds.slice(i, i + CHUNK) },
    );
  }
}

async function addIssuesToCycle(cycleId: string, workItemIds: string[]): Promise<void> {
  if (workItemIds.length === 0) return;
  const CHUNK = 100;
  for (let i = 0; i < workItemIds.length; i += CHUNK) {
    await plane.post(
      `/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/projects/${PLANE_PROJECT_ID}/cycles/${cycleId}/cycle-issues/`,
      { issues: workItemIds.slice(i, i + CHUNK) },
    );
  }
}

/** Delete cycles previously created by this importer. Used to clean up
 *  cycles that should have been modules under the current rule. */
async function deleteOrphanCycles(cycles: PlaneCycle[]): Promise<number> {
  let deleted = 0;
  for (const c of cycles) {
    if (c.external_source !== EXTERNAL_SOURCE) continue;
    try {
      await plane.delete(
        `/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/projects/${PLANE_PROJECT_ID}/cycles/${c.id}/`,
      );
      console.log(`  deleted cycle: ${c.name}`);
      deleted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  failed to delete cycle ${c.name}: ${msg}`);
    }
  }
  return deleted;
}

async function main() {
  console.log(`Migrating Jira ${PROJECT_KEY} sprints → Plane modules/cycles…`);

  await ensureViewsEnabled();

  // Optional cleanup pass.
  if (DELETE_ORPHAN_CYCLES) {
    console.log(`Deleting orphan cycles (external_source=${EXTERNAL_SOURCE})…`);
    const existingCycles = await listPlaneCycles();
    const n = await deleteOrphanCycles(existingCycles);
    console.log(`  deleted ${n} orphan cycle(s)`);
  }

  // Plane state we'll reconcile against.
  const planeIssues = await listPlaneIssuesByJiraKey();
  console.log(`  Plane work items indexed: ${planeIssues.size}`);

  const planeCycles = await listPlaneCycles();
  const cyclesByExtId = new Map<string, PlaneCycle>();
  for (const c of planeCycles) {
    if (c.external_source === EXTERNAL_SOURCE && c.external_id) {
      cyclesByExtId.set(c.external_id, c);
    }
  }
  const planeModules = await listPlaneModules();
  const modulesByExtId = new Map<string, PlaneModule>();
  for (const m of planeModules) {
    if (m.external_source === EXTERNAL_SOURCE && m.external_id) {
      modulesByExtId.set(m.external_id, m);
    }
  }
  console.log(
    `  existing migrated cycles:  ${cyclesByExtId.size}\n` +
      `  existing migrated modules: ${modulesByExtId.size}`,
  );

  // Pull all sprints from the Jira board (includes empty ones).
  const allSprints = await listJiraSprintsOnBoard();
  console.log(`  Jira sprints on board:    ${allSprints.length}`);

  // Pass 1: create cycles/modules.
  console.log(`Creating Plane modules/cycles…`);
  let createdCycles = 0;
  let createdModules = 0;
  for (const sprint of allSprints) {
    try {
      if (classify(sprint) === 'cycle') {
        if (!cyclesByExtId.has(String(sprint.id))) {
          await ensureCycle(sprint, cyclesByExtId);
          createdCycles++;
        }
      } else {
        if (!modulesByExtId.has(String(sprint.id))) {
          await ensureModule(sprint, modulesByExtId);
          createdModules++;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  skipped sprint ${sprint.id} (${sprint.name}): ${msg}`);
    }
  }
  console.log(`  cycles created: ${createdCycles}, modules created: ${createdModules}`);

  // Pass 2: walk issue→sprint memberships and bucket by target.
  console.log(`Reading Jira sprint assignments…`);
  type Bucket = { kind: 'cycle' | 'module'; id: string; name: string; ids: string[] };
  const buckets = new Map<string, Bucket>(); // keyed by `<kind>:<plane_id>`
  let scanned = 0;
  let withoutPlaneIssue = 0;
  let withoutTarget = 0;

  for await (const { issueKey, sprints } of iterateJiraSprintAssignments()) {
    scanned++;
    const planeId = planeIssues.get(issueKey);
    if (!planeId) {
      withoutPlaneIssue++;
      continue;
    }
    if (sprints.length === 0) continue;

    // Pick the most-recent sprint (latest endDate, fallback highest id).
    const sorted = sprints.slice().sort((a, b) => {
      const ae = a.endDate ?? '';
      const be = b.endDate ?? '';
      if (ae !== be) return ae < be ? 1 : -1;
      return b.id - a.id;
    });
    const target = sorted[0];

    // Find the Plane row for that sprint.
    const extId = String(target.id);
    const cycle = cyclesByExtId.get(extId);
    const mod = modulesByExtId.get(extId);
    let bucketKey: string | undefined;
    let kind: 'cycle' | 'module' | undefined;
    let id: string | undefined;
    let name: string | undefined;
    if (cycle) {
      bucketKey = `cycle:${cycle.id}`;
      kind = 'cycle';
      id = cycle.id;
      name = cycle.name;
    } else if (mod) {
      bucketKey = `module:${mod.id}`;
      kind = 'module';
      id = mod.id;
      name = mod.name;
    } else {
      withoutTarget++;
      continue;
    }
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { kind: kind!, id: id!, name: name!, ids: [] };
      buckets.set(bucketKey, bucket);
    }
    bucket.ids.push(planeId);
  }
  console.log(`  scanned ${scanned} issues, ${buckets.size} target buckets`);
  if (withoutPlaneIssue) console.log(`  ${withoutPlaneIssue} issue(s) had no matching Plane work item`);
  if (withoutTarget) console.log(`  ${withoutTarget} issue(s) had no matching cycle/module`);

  // Pass 3: assign issues.
  console.log(`Assigning issues to modules/cycles…`);
  let assigned = 0;
  let failures = 0;
  for (const bucket of buckets.values()) {
    try {
      if (bucket.kind === 'cycle') {
        await addIssuesToCycle(bucket.id, bucket.ids);
      } else {
        await addIssuesToModule(bucket.id, bucket.ids);
      }
      assigned += bucket.ids.length;
      console.log(`  ${bucket.kind}: ${bucket.name} ← ${bucket.ids.length} issue(s)`);
    } catch (err) {
      const e = err as AxiosError;
      const body = e.response?.data ? JSON.stringify(e.response.data) : String(err);
      console.warn(`  ${bucket.kind} ${bucket.name}: ${body}`);
      failures += bucket.ids.length;
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Jira sprints on board:    ${allSprints.length}`);
  console.log(`  Plane cycles (created):   ${createdCycles}`);
  console.log(`  Plane modules (created):  ${createdModules}`);
  console.log(`  buckets to fill:          ${buckets.size}`);
  console.log(`  issues assigned:          ${assigned}`);
  console.log(`  issue assignments failed: ${failures}`);
}

main().catch((err) => {
  const e = err as AxiosError;
  if (e.isAxiosError && e.response) {
    console.error(`HTTP ${e.response.status}:`, JSON.stringify(e.response.data));
  } else {
    console.error(err);
  }
  process.exit(1);
});