/**
 * Rewrite Jira-hosted inline images in Plane work-item descriptions
 * into Plane's editor-native `<image-component>` tags.
 *
 * The upstream importer copies Jira's `renderedFields.description`
 * HTML verbatim, so inline images keep their original
 *   <img src="https://<atlassian>/rest/api/3/attachment/content/14937" alt="...">
 * URLs. Plane has no Jira session, so the browser fails to load them.
 *
 * Plane's TipTap editor parses `<image-component>` (a custom node),
 * NOT plain `<img>`. The component's `src` attribute is the asset
 * UUID; the editor's `getAssetSrc` callback wraps it into a real
 * URL at render time. Verified against
 * `packages/editor/src/core/extensions/custom-image/extension-config.ts`
 * in upstream preview, then validated by hand-PATCHing a single issue
 * (WZ-1256 on dev) and seeing it render in the browser.
 *
 * Each migrated attachment has its Jira numeric id stored in
 * `external_id`. We look up the matching Plane attachment for each
 * Jira id referenced in the description and replace the entire
 * `<img>` tag with `<image-component id="<asset>" src="<asset>"
 * status="uploaded" alignment="left" width="35%" height="auto">`.
 *
 * Idempotent: a description that's already been rewritten contains
 * no `<img>` tags pointing at Jira, so the regex finds nothing and
 * the issue is skipped.
 *
 * Usage:
 *   npm run scripts:rewrite-image-urls -- \
 *     --plane-project <uuid> [--dry-run]
 *
 * Reads PLANE_HOST, PLANE_API_KEY, PLANE_WORKSPACE_SLUG from .env.
 */

import { config as loadEnv } from 'dotenv';
import axios from 'axios';
import type { AxiosError } from 'axios';

import { botToken } from '../src/utils/auth.js';

loadEnv();

const flags = parseArgs(process.argv.slice(2));
const PLANE_PROJECT_ID = flags['plane-project'] ?? process.env.PLANE_PROJECT_ID;
const DRY_RUN = flags['dry-run'] === 'true';

const PLANE_HOST = required('PLANE_HOST');
const PLANE_API_KEY = botToken();
const PLANE_WORKSPACE_SLUG = required('PLANE_WORKSPACE_SLUG');

if (!PLANE_PROJECT_ID) {
  console.error('Missing --plane-project <uuid> (or PLANE_PROJECT_ID env)');
  process.exit(1);
}

const plane = axios.create({
  baseURL: PLANE_HOST,
  headers: { 'X-API-Key': PLANE_API_KEY, Accept: 'application/json' },
});

// Plane's API_KEY_RATE_LIMIT defaults to 60/min on the server (we
// raised ours to 600/min). Even at 600/min, walking 1199 issues +
// fetching attachments per issue + PATCHing rewrites bursts past the
// limit without throttling. 200ms ≈ 5 req/sec ≈ 300/min.
const REQ_DELAY_MS = Number(process.env.PLANE_REQ_DELAY_MS ?? '200');
plane.interceptors.request.use(async (config) => {
  if (REQ_DELAY_MS > 0) await new Promise((r) => setTimeout(r, REQ_DELAY_MS));
  return config;
});

interface PlaneIssue {
  id: string;
  external_id: string | null;
  external_source: string | null;
  description_html: string | null;
}

interface PlaneAttachment {
  id: string;
  issue: string;
  external_id: string | null;
  external_source: string | null;
  attributes: { name?: string; type?: string };
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

/** Walk all Plane work items in the project. */
async function* iterateIssues(): AsyncGenerator<PlaneIssue> {
  let cursor: string | undefined;
  for (;;) {
    const { data } = await plane.get(
      `/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/projects/${PLANE_PROJECT_ID}/issues/`,
      { params: cursor ? { cursor, per_page: 100 } : { per_page: 100 } },
    );
    for (const i of (data.results ?? []) as PlaneIssue[]) yield i;
    if (data.next_page_results && data.next_cursor) cursor = data.next_cursor;
    else return;
  }
}

/**
 * For one work item, list its attachments and build a Map keyed on
 * Jira attachment id (the external_id we set during import).
 */
async function attachmentsByJiraId(workItemId: string): Promise<Map<string, PlaneAttachment>> {
  const { data } = await plane.get<PlaneAttachment[]>(
    `/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/projects/${PLANE_PROJECT_ID}/work-items/${workItemId}/attachments/`,
  );
  const out = new Map<string, PlaneAttachment>();
  for (const a of data) {
    if (a.external_source === 'jira-importer' && a.external_id) {
      out.set(a.external_id, a);
    }
  }
  return out;
}

/**
 * Build the editor-native image-component tag. Plane's TipTap
 * custom-image extension stores the asset UUID in `src`; `getAssetSrc`
 * wraps it into a real URL at render time. `width="35%"`, `height="auto"`,
 * `alignment="left"` are the defaults from
 * `DEFAULT_CUSTOM_IMAGE_ATTRIBUTES` in upstream's utils.ts.
 */
function imageComponent(assetId: string): string {
  return `<image-component id="${assetId}" src="${assetId}" status="uploaded" alignment="left" width="35%" height="auto"></image-component>`;
}

/**
 * Replace each Jira-hosted `<img src="https://...atlassian.net/.../attachment/content/<id>">`
 * tag with an `<image-component>` pointing at the migrated Plane
 * attachment. Returns the new HTML, count of rewrites performed, and
 * any unmatched Jira ids (e.g. attachments from comments the importer
 * didn't migrate inline).
 */
function rewriteHtml(
  html: string,
  attMap: Map<string, PlaneAttachment>,
): { html: string; rewrites: string[]; unmatched: string[] } {
  const rewrites: string[] = [];
  const unmatched: string[] = [];

  // Match the entire <img ...> tag where src contains a Jira media URL.
  // Capture group 1 = Jira attachment id.
  const pattern =
    /<img\s[^>]*?src="https?:\/\/[^"]*?\.atlassian\.net\/[^"]*?attachment\/content\/(\d+)[^"]*"[^>]*>/g;

  const newHtml = html.replace(pattern, (match, jiraId: string) => {
    const att = attMap.get(jiraId);
    if (!att) {
      unmatched.push(jiraId);
      return match;
    }
    rewrites.push(`${jiraId} → ${att.id}`);
    return imageComponent(att.id);
  });

  return { html: newHtml, rewrites, unmatched };
}

async function main() {
  console.log(`Rewriting Jira image markup → Plane image-component in ${PLANE_PROJECT_ID}…`);
  if (DRY_RUN) console.log('DRY RUN — no PATCH writes');

  // Quick filter: skip issues that don't reference any Jira media URL.
  // This means the issue is either pristine (no images) or already
  // rewritten — either way, no work to do.
  const needsRewrite = /<img\s[^>]*?src="https?:\/\/[^"]*?\.atlassian\.net\/[^"]*?attachment\/content\/\d+/;

  let scanned = 0;
  let touched = 0;
  let totalRewrites = 0;
  let totalUnmatched = 0;
  let errors = 0;

  for await (const issue of iterateIssues()) {
    scanned++;
    if (!issue.description_html) continue;
    if (!needsRewrite.test(issue.description_html)) continue;

    const att = await attachmentsByJiraId(issue.id);
    const { html, rewrites, unmatched } = rewriteHtml(issue.description_html, att);

    if (rewrites.length === 0 && unmatched.length === 0) continue;

    totalRewrites += rewrites.length;
    totalUnmatched += unmatched.length;

    const key = issue.external_id ?? issue.id.slice(0, 8);
    if (rewrites.length > 0) {
      console.log(
        `  ${key}: ${rewrites.length} rewrite(s)${unmatched.length ? `, ${unmatched.length} unmatched` : ''}`,
      );
      if (!DRY_RUN) {
        try {
          await plane.patch(
            `/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/projects/${PLANE_PROJECT_ID}/issues/${issue.id}/`,
            { description_html: html },
          );
          touched++;
        } catch (err) {
          errors++;
          const e = err as AxiosError;
          const body = e.response?.data ? JSON.stringify(e.response.data) : String(err);
          console.warn(`    PATCH failed: ${body}`);
        }
      } else {
        touched++;
      }
    } else if (unmatched.length > 0) {
      console.log(`  ${key}: ${unmatched.length} unmatched Jira id(s) [${unmatched.join(',')}]`);
    }
  }

  console.log(`\nSummary:`);
  console.log(`  issues scanned:           ${scanned}`);
  console.log(`  issues with rewrites:     ${touched}${DRY_RUN ? ' (dry run)' : ''}`);
  console.log(`  total img rewrites:       ${totalRewrites}`);
  console.log(`  unmatched Jira ids:       ${totalUnmatched}`);
  console.log(`  PATCH errors:             ${errors}`);
  if (errors) process.exit(1);
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