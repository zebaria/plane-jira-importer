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
 * Auto-matches by name (case-insensitive). Falls back to an interactive
 * inquirer prompt for unmatched statuses.
 */
export async function buildStatusMap(
  jiraStatuses: string[],
  planeStates: PlaneState[],
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};

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
 * Build a mapping from Jira account IDs to Plane member IDs.
 *
 * Auto-matches by email (case-insensitive). Falls back to an interactive
 * inquirer prompt for unmatched users.
 */
export async function buildUserMap(
  jiraUsers: JiraUser[],
  planeMembers: PlaneMember[],
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};

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
      map[user.accountId] = selectedMemberId as string;
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
