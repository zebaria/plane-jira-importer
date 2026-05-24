/**
 * Mapping utilities for Jira → Plane data transformation.
 *
 * Handles priority mapping, status/user matching (with interactive fallback),
 * label creation, and extraction of unique metadata from Jira issues.
 */

import inquirer from 'inquirer';
import type { PlaneClient } from '../clients/plane.js';
import type { JiraIssue, JiraUser } from '../types/jira.js';
import type { PlanePriority, PlaneState, PlaneMember } from '../types/plane.js';
import type { UsersFile, StateMappingFile } from '../types/config.js';
import { log } from '../utils/logger.js';

// ─── Priority Mapping ────────────────────────────────────────────────────────

/**
 * Map a Jira priority name to a Plane priority value.
 *
 * Highest → urgent, High → high, Medium → medium,
 * Low/Lowest → low, everything else → none.
 */
export function mapPriority(jiraPriority: string | null): PlanePriority {
  if (!jiraPriority) return 'none';

  switch (jiraPriority.toLowerCase()) {
    case 'highest':
      return 'urgent';
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    case 'low':
    case 'lowest':
      return 'low';
    default:
      return 'none';
  }
}

// ─── Status Mapping ──────────────────────────────────────────────────────────

/**
 * Build a mapping from Jira status names to Plane state IDs.
 *
 * If `stateFile` is provided, resolve via the file (Jira name → Plane name
 * → Plane id) and skip prompts entirely. Statuses that the file leaves
 * unmapped (`null` in the file, or absent) fail loudly — the operator
 * should fix the file and re-run, not silently lose data.
 *
 * Otherwise, auto-match by name (case-insensitive) and fall back to an
 * interactive prompt for unmatched statuses.
 */
export async function buildStatusMap(
  jiraStatuses: string[],
  planeStates: PlaneState[],
  stateFile?: StateMappingFile,
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};

  if (stateFile) {
    // Build a lowercase-name → ids[] index. Plane allows multiple
    // states with the same display name across different groups
    // (e.g. a "Done" in the Completed group and another in the
    // Cancelled group), so we collect *all* matches per name and
    // warn if we have to pick one ambiguously.
    const planeByName = new Map<string, PlaneState[]>();
    for (const s of planeStates) {
      const key = s.name.toLowerCase();
      const bucket = planeByName.get(key) ?? [];
      bucket.push(s);
      planeByName.set(key, bucket);
    }

    const missing: string[] = [];
    for (const status of jiraStatuses) {
      const targetName = stateFile.mapping[status];
      if (!targetName) {
        missing.push(`"${status}" → (unmapped)`);
        continue;
      }
      const matches = planeByName.get(targetName.toLowerCase()) ?? [];
      if (matches.length === 0) {
        missing.push(`"${status}" → "${targetName}" (no Plane state by that name)`);
        continue;
      }
      const chosen = matches[0];
      if (matches.length > 1) {
        const alts = matches
          .map((s) => `"${s.name}" (group=${s.group}, id=${s.id})`)
          .join(', ');
        log.warn(
          `Plane has ${matches.length} states named "${targetName}": ${alts}. ` +
            `Picking the first (group=${chosen.group}). Disambiguate by ` +
            `renaming one of the duplicate states in Plane, or by editing ` +
            `the state-mapping file to reference a unique name.`,
        );
      }
      map[status] = chosen.id;
      log.dim(`  ${status} → ${targetName} (group=${chosen.group})`);
    }
    if (missing.length > 0) {
      log.error(`State mapping file is incomplete:\n  ${missing.join('\n  ')}`);
      throw new Error('State mapping incomplete; fix data/state-mapping.json and re-run');
    }
    return map;
  }

  for (const status of jiraStatuses) {
    const autoMatch = planeStates.find(
      (s) => s.name.toLowerCase() === status.toLowerCase(),
    );

    const choices = planeStates.map((s) => ({
      name: `${s.name} (${s.group})`,
      value: s.id,
    }));

    if (autoMatch) {
      log.dim(`  Auto-match suggestion: "${status}" → "${autoMatch.name}"`);
    }

    const { stateId } = await inquirer.prompt([
      {
        type: 'list',
        name: 'stateId',
        message: `Map Jira status "${status}" to Plane state:`,
        choices,
        default: autoMatch?.id,
      },
    ]);
    map[status] = stateId as string;
  }

  return map;
}

// ─── User Mapping ────────────────────────────────────────────────────────────

/**
 * Resolution result for a Jira user.
 *
 *  - `planeMemberId` is set when the user resolved to an active Plane
 *    workspace member; the work item can be assigned to them.
 *  - When unset, the migrator falls back to noting the original
 *    assignee in the description — see `unresolvedNote` for the human
 *    text to embed.
 */
export interface UserResolution {
  planeMemberId: string | null;
  /** Human-readable identifier for the description fallback note. */
  unresolvedNote?: string;
}

/**
 * Build a mapping from Jira account IDs to a resolved user record.
 *
 * If `usersFile` is provided, resolve every Jira account via the file:
 *   accountId → file entry → email → Plane member (by email)
 * When the email matches a current Plane member, the assignee is
 * mapped. Otherwise the entry is recorded with `unresolvedNote` so the
 * migrator can mention the original assignee in the description. This
 * is the expected path while invites are still pending.
 *
 * Without `usersFile`, falls back to the legacy interactive prompt
 * flow — auto-match by email, prompt for the rest.
 */
export async function buildUserMap(
  jiraUsers: JiraUser[],
  planeMembers: PlaneMember[],
  usersFile?: UsersFile,
): Promise<Record<string, UserResolution>> {
  const map: Record<string, UserResolution> = {};

  if (usersFile) {
    const memberByEmail = new Map<string, PlaneMember>();
    for (const m of planeMembers) {
      if (m.email) memberByEmail.set(m.email.toLowerCase(), m);
    }

    let resolvedToMember = 0;
    let pendingInvite = 0;
    let noEmail = 0;
    let notInFile = 0;

    for (const user of jiraUsers) {
      const entry = usersFile[user.accountId];
      if (!entry) {
        notInFile++;
        map[user.accountId] = {
          planeMemberId: null,
          unresolvedNote: `${user.displayName} (jira:${user.accountId}, not in users-file)`,
        };
        continue;
      }
      if (!entry.email) {
        noEmail++;
        map[user.accountId] = {
          planeMemberId: null,
          unresolvedNote: `${entry.display_name} (no email)`,
        };
        continue;
      }
      const member = memberByEmail.get(entry.email.toLowerCase());
      if (member) {
        resolvedToMember++;
        map[user.accountId] = { planeMemberId: member.id };
      } else {
        // Email known but not yet a Plane member — likely a pending
        // invitation. Record the email so the importer can put it in
        // the description note. Once the user accepts the invite, a
        // re-run with `--reimport` will pick them up.
        pendingInvite++;
        const flag = entry.current ? '' : ' [former]';
        map[user.accountId] = {
          planeMemberId: null,
          unresolvedNote: `${entry.display_name} <${entry.email}>${flag}`,
        };
      }
    }

    log.dim(`  User map (file mode):`);
    log.dim(`    resolved to Plane member: ${resolvedToMember}`);
    log.dim(`    pending invite (noted in description): ${pendingInvite}`);
    log.dim(`    no email (noted in description):       ${noEmail}`);
    log.dim(`    not in users-file (noted):             ${notInFile}`);
    return map;
  }

  for (const user of jiraUsers) {
    const autoMatch = planeMembers.find(
      (m) =>
        m.email &&
        user.emailAddress &&
        m.email.toLowerCase() === user.emailAddress.toLowerCase(),
    );

    const choices = [
      { name: '(skip — leave unassigned)', value: '' },
      ...planeMembers.map((m) => ({
        name: `${m.display_name ?? 'Unknown'} (${m.email ?? 'no email'})`,
        value: m.id,
      })),
    ];

    if (autoMatch) {
      log.dim(
        `  Auto-match suggestion: "${user.displayName}" → "${autoMatch.display_name ?? autoMatch.email ?? 'unknown'}"`,
      );
    }

    const { selectedMemberId } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedMemberId',
        message: `Map Jira user "${user.displayName}" (${user.emailAddress ?? 'no email'}) to Plane member:`,
        choices,
        default: autoMatch?.id,
      },
    ]);

    if (selectedMemberId) {
      map[user.accountId] = { planeMemberId: selectedMemberId as string };
    } else {
      map[user.accountId] = {
        planeMemberId: null,
        unresolvedNote: user.displayName,
      };
    }
  }

  return map;
}

// ─── Label Management ────────────────────────────────────────────────────────

/**
 * Ensure a "Jira: {type}" label exists in the Plane project.
 *
 * Uses the provided cache to avoid redundant API calls.
 * Returns the label ID, or `null` if creation failed.
 */
export async function ensureTypeLabel(
  plane: PlaneClient,
  projectId: string,
  issueType: string,
  labelCache: Map<string, string>,
): Promise<string | null> {
  const labelName = `Jira: ${issueType}`;

  const cached = labelCache.get(labelName);
  if (cached) {
    return cached;
  }

  try {
    const label = await plane.createLabel(projectId, labelName);
    if (label) {
      labelCache.set(labelName, label.id);
      return label.id;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to create label "${labelName}": ${msg}`);
  }

  return null;
}

// ─── Extraction Helpers ──────────────────────────────────────────────────────

/** Extract unique status names from a collection of Jira issues. */
export function extractStatuses(issues: JiraIssue[]): string[] {
  const statuses = new Set<string>();
  for (const issue of issues) {
    if (issue.fields.status?.name) {
      statuses.add(issue.fields.status.name);
    }
  }
  return [...statuses];
}

/**
 * Extract unique users from a collection of Jira issues.
 *
 * Collects users from assignee, reporter, and creator fields
 * so all project participants can be mapped.
 */
export function extractUsers(issues: JiraIssue[]): JiraUser[] {
  const seen = new Map<string, JiraUser>();

  for (const issue of issues) {
    for (const user of [issue.fields.assignee, issue.fields.reporter, issue.fields.creator]) {
      if (user && !seen.has(user.accountId)) {
        seen.set(user.accountId, user);
      }
    }
  }

  return [...seen.values()];
}

/** @deprecated Use {@link extractUsers} instead. */
export const extractAssignees = extractUsers;

/** Extract unique issue type names from a collection of Jira issues. */
export function extractIssueTypes(issues: JiraIssue[]): string[] {
  const types = new Set<string>();
  for (const issue of issues) {
    if (issue.fields.issuetype?.name) {
      types.add(issue.fields.issuetype.name);
    }
  }
  return [...types];
}
