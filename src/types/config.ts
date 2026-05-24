/**
 * Configuration and environment types.
 *
 * Kept free of imports from client/service modules to avoid circular
 * dependencies.  The {@link IRateLimiter} interface is defined here so
 * both the implementation and consumers can reference it without coupling.
 */

// ─── Rate Limiter Interface ──────────────────────────────────────────────────

/** Minimal contract a rate-limiter must satisfy. */
export interface IRateLimiter {
  wait(): Promise<void>;
}

// ─── Client Configuration ────────────────────────────────────────────────────

/** Configuration for the Jira API client. */
export interface JiraConfig {
  /** Jira Cloud hostname, e.g. `acme.atlassian.net`. */
  host: string;
  /** Email address used for Jira Basic auth. */
  email: string;
  /** Jira API token. */
  apiToken: string;
  /** Rate limiter instance for Jira API calls. */
  rateLimiter: IRateLimiter;
  /** Maximum retry attempts for transient failures (default: 3). */
  maxRetries?: number;
}

/** Configuration for the Plane API client. */
export interface PlaneConfig {
  /** Full URL of the Plane instance, e.g. `https://plane.acme.com`. */
  host: string;
  /** Plane API key. */
  apiKey: string;
  /** Plane workspace slug. */
  workspaceSlug: string;
  /** Rate limiter instance shared across all Plane API calls. */
  rateLimiter: IRateLimiter;
  /** Maximum retry attempts for transient failures (default: 3). */
  maxRetries?: number;
}

// ─── Migration Configuration ─────────────────────────────────────────────────

/** Runtime configuration for the migration process. */
export interface MigrationConfig {
  /** Maximum retry attempts for API calls (default: 3). */
  maxRetries: number;
  /**
   * Maximum attachment size in megabytes.
   * Attachments exceeding this limit are skipped with a warning (default: 100).
   */
  maxAttachmentSizeMb: number;
}

// ─── User Mapping File ───────────────────────────────────────────────────────

/**
 * A single user entry in the user-mapping JSON file. Produced by
 * `scripts/pull-jira-users.ts`, hand-edited by the operator to fill
 * emails the Jira API hides and to flag former employees.
 */
export interface UserFileEntry {
  display_name: string;
  /** Plane email. `null` if unknown — assignee will be skipped + noted. */
  email: string | null;
  /**
   * Whether the person is still an active member. Used only for human
   * context in logs and the description fallback note; the importer
   * treats `current=false` users the same as `current=true` (we still
   * try to match by email).
   */
  current: boolean;
  _seen_in: string[];
}

/** Parsed user-mapping JSON: Jira accountId → entry. */
export type UsersFile = Record<string, UserFileEntry>;

// ─── State Mapping File ──────────────────────────────────────────────────────

/** Parsed state-mapping JSON. Produced by `scripts/pull-state-mapping.ts`. */
export interface StateMappingFile {
  _plane_states?: Array<{ id: string; name: string; group: string }>;
  /** Jira status name → Plane state name (or null if intentionally unmapped). */
  mapping: Record<string, string | null>;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

/** Parsed CLI flags from `process.argv`. */
export interface CliFlags {
  'dry-run'?: string | boolean;
  'reimport'?: string | boolean;
  'project-key'?: string;
  'plane-project'?: string;
  /** Path to a JSON file mapping Jira accountId → user record. */
  'users-file'?: string;
  /** Path to a JSON file mapping Jira status name → Plane state name. */
  'state-mapping-file'?: string;
  [key: string]: string | boolean | undefined;
}

/** Names of environment variables the importer requires. */
export type RequiredEnvVar =
  | 'JIRA_HOST'
  | 'JIRA_EMAIL'
  | 'JIRA_API_TOKEN'
  | 'PLANE_HOST'
  | 'PLANE_API_KEY'
  | 'PLANE_WORKSPACE_SLUG';
