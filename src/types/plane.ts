/**
 * Plane API response types.
 *
 * Covers the subset of the Plane v1 REST API used by this importer:
 * projects, states, labels, members, work items, comments, and attachments.
 */

// ─── Value Types ─────────────────────────────────────────────────────────────

/** Valid Plane priority values. */
export type PlanePriority = 'urgent' | 'high' | 'medium' | 'low' | 'none';

/** Plane workflow state groups. */
export type PlaneStateGroup = 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';

// ─── Core Entities ───────────────────────────────────────────────────────────

/** Plane project. */
export interface PlaneProject {
  id: string;
  identifier: string;
  name: string;
  description?: string;
}

/** Plane workflow state. */
export interface PlaneState {
  id: string;
  name: string;
  group: string;
  color?: string;
}

/** Plane label. */
export interface PlaneLabel {
  id: string;
  name: string;
  color?: string;
}

/**
 * Plane workspace member.
 *
 * The v1 API returns a flat structure with user fields directly on the
 * member object (no nested `member` key).
 */
export interface PlaneMember {
  id: string;
  email?: string;
  display_name?: string;
  first_name?: string;
  last_name?: string;
  role?: number;
}

/** Plane work item (issue). */
export interface PlaneWorkItem {
  id: string;
  name: string;
  external_id?: string;
  external_source?: string;
  description_html?: string;
  priority?: string;
  state?: string;
  assignees?: string[];
  labels?: string[];
  parent?: string;
  start_date?: string;
  target_date?: string;
}

// ─── Payloads ────────────────────────────────────────────────────────────────

/** Payload for creating a work item. */
export interface CreateWorkItemPayload {
  name: string;
  description_html: string;
  priority: string;
  external_id: string;
  external_source: string;
  state?: string;
  assignees?: string[];
  labels?: string[];
  parent?: string;
  start_date?: string;
  target_date?: string;
}

/** Payload for adding a comment to a work item. */
export interface CreateCommentPayload {
  comment_html: string;
  external_source: string;
  external_id: string;
}

/** External tracking metadata attached to attachments. */
export interface ExternalMeta {
  external_id: string;
  external_source: string;
}

// ─── API Responses ───────────────────────────────────────────────────────────

/** Paginated response wrapper used by several Plane endpoints. */
export interface PlanePaginatedResponse<T> {
  results: T[];
  next_cursor?: string;
  next_page_results?: boolean;
}

/** Shape returned when Plane provides either a flat array or paginated wrapper. */
export type PlaneApiResponse<T> = T[] | PlanePaginatedResponse<T>;

/** Upload credentials returned when initiating an attachment upload. */
export interface PlaneUploadCredentials {
  asset_id?: string;
  id?: string;
  upload_data?: {
    url: string;
    fields: Record<string, string>;
  };
}

/** Plane comment (returned after creation or listing). */
export interface PlaneComment {
  id: string;
  comment_html?: string;
  external_id?: string;
  external_source?: string;
}

/** Plane attachment (returned after confirmation or listing). */
export interface PlaneAttachment {
  id: string;
  name?: string;
  external_id?: string;
  external_source?: string;
}
