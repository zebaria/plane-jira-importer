/**
 * Plane API client.
 *
 * Uses `X-API-Key` authentication and the v1 API.
 * All operations respect rate limits and retry transient failures
 * with exponential backoff.
 */

import axios from 'axios';
import type { AxiosInstance } from 'axios';
import { withRetry } from '../utils/retry.js';
import type { IRateLimiter, PlaneConfig } from '../types/config.js';
import type {
  PlaneProject,
  PlaneState,
  PlaneLabel,
  PlaneMember,
  PlaneWorkItem,
  PlaneComment,
  PlaneAttachment,
  PlaneUploadCredentials,
  PlaneApiResponse,
  CreateWorkItemPayload,
  CreateCommentPayload,
  ExternalMeta,
} from '../types/plane.js';

const EMPTY_EXTERNAL_META: ExternalMeta = { external_id: '', external_source: '' };

export class PlaneClient {
  private readonly workspaceSlug: string;
  private readonly rateLimiter: IRateLimiter;
  private readonly maxRetries: number;
  private readonly client: AxiosInstance;
  /** Public-host axios for endpoints not under /api/v1 (e.g. /api/instances/). */
  private readonly publicClient: AxiosInstance;

  constructor(config: PlaneConfig) {
    this.workspaceSlug = config.workspaceSlug;
    this.rateLimiter = config.rateLimiter;
    this.maxRetries = config.maxRetries ?? 3;

    const baseHost = config.host.replace(/\/+$/, '');
    this.client = axios.create({
      baseURL: `${baseHost}/api/v1`,
      headers: {
        'X-API-Key': config.apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    });
    this.publicClient = axios.create({
      baseURL: baseHost,
      headers: { Accept: 'application/json' },
      timeout: 30_000,
    });
  }

  // ── Instance ─────────────────────────────────────────────────────────────

  /**
   * Fetch the public instance config. Currently only used to read
   * `FILE_SIZE_LIMIT` so we can warn (and clamp) when the importer's
   * `MAX_ATTACHMENT_SIZE_MB` exceeds what the server will actually
   * accept — Plane silently caps the S3 presigned URL's
   * content-length-range at `min(client_size, FILE_SIZE_LIMIT)`, so
   * any larger attachment is rejected by S3 with `EntityTooLarge`.
   *
   * Endpoint is unauthenticated and at `/api/instances/`, not under
   * `/api/v1/`.
   */
  async getInstanceFileSizeLimit(): Promise<number | null> {
    try {
      const { data } = await this.publicClient.get<{
        config?: { file_size_limit?: number };
      }>('/api/instances/');
      const limit = data.config?.file_size_limit;
      return typeof limit === 'number' && Number.isFinite(limit) ? limit : null;
    } catch {
      return null;
    }
  }

  // ── Projects ─────────────────────────────────────────────────────────────

  /** List all projects in the workspace. */
  async listProjects(): Promise<PlaneProject[]> {
    const results: PlaneProject[] = [];
    let cursor: string | undefined;

    for (;;) {
      const page = await this.apiCall(
        async () => {
          const { data } = await this.client.get<PlaneApiResponse<PlaneProject>>(
            `/workspaces/${this.workspaceSlug}/projects/`,
            { params: cursor ? { cursor } : {} },
          );
          return data;
        },
        cursor ? `listing projects (cursor ${cursor})` : 'listing projects',
      );

      if (Array.isArray(page)) {
        results.push(...page);
        break;
      } else if (page.results) {
        results.push(...page.results);
        if (page.next_page_results && page.next_cursor) {
          cursor = page.next_cursor;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    return results;
  }

  // ── States ───────────────────────────────────────────────────────────────

  /** List all states for a project. */
  async listStates(projectId: string): Promise<PlaneState[]> {
    return this.apiCall(
      async () => {
        const { data } = await this.client.get<PlaneApiResponse<PlaneState>>(
          `/workspaces/${this.workspaceSlug}/projects/${projectId}/states/`,
        );
        return Array.isArray(data) ? data : data.results ?? [];
      },
      'listing Plane states',
    );
  }

  // ── Labels ───────────────────────────────────────────────────────────────

  /** List all labels for a project. */
  async listLabels(projectId: string): Promise<PlaneLabel[]> {
    return this.apiCall(
      async () => {
        const { data } = await this.client.get<PlaneApiResponse<PlaneLabel>>(
          `/workspaces/${this.workspaceSlug}/projects/${projectId}/labels/`,
        );
        return Array.isArray(data) ? data : data.results ?? [];
      },
      'listing Plane labels',
    );
  }

  /**
   * Create a label in a project.
   *
   * If the label already exists (409 Conflict) the existing label is returned.
   * Uses `withRetry` directly (instead of `apiCall`) so the raw Axios error
   * is available for 409 detection before `handleError` transforms it.
   */
  async createLabel(projectId: string, name: string): Promise<PlaneLabel | null> {
    try {
      return await withRetry(
        async () => {
          await this.rateLimiter.wait();
          const { data } = await this.client.post<PlaneLabel>(
            `/workspaces/${this.workspaceSlug}/projects/${projectId}/labels/`,
            { name },
          );
          return data;
        },
        { maxRetries: this.maxRetries, context: `creating label "${name}"` },
      );
    } catch (err: unknown) {
      // 409 Conflict = label already exists — fetch and return it
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        const existing = await this.listLabels(projectId);
        return existing.find((l) => l.name === name) ?? null;
      }
      this.handleError(err, `creating label "${name}"`);
    }
  }

  // ── Members ──────────────────────────────────────────────────────────────

  /** List all workspace members. */
  async listMembers(): Promise<PlaneMember[]> {
    return this.apiCall(
      async () => {
        const { data } = await this.client.get<PlaneApiResponse<PlaneMember>>(
          `/workspaces/${this.workspaceSlug}/members/`,
        );
        return Array.isArray(data) ? data : data.results ?? [];
      },
      'listing Plane members',
    );
  }

  // ── Work Items ───────────────────────────────────────────────────────────

  /** List all work items for a project (paginated). */
  async listWorkItems(projectId: string): Promise<PlaneWorkItem[]> {
    const results: PlaneWorkItem[] = [];
    let cursor: string | undefined;

    for (;;) {
      const page = await this.apiCall(
        async () => {
          const { data } = await this.client.get<PlaneApiResponse<PlaneWorkItem>>(
            `/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/`,
            { params: cursor ? { cursor } : {} },
          );
          return data;
        },
        cursor ? `listing work items (cursor ${cursor})` : 'listing work items',
      );

      if (Array.isArray(page)) {
        results.push(...page);
        break;
      } else if (page.results) {
        results.push(...page.results);
        if (page.next_page_results && page.next_cursor) {
          cursor = page.next_cursor;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    return results;
  }

  /** Delete a work item from a project. */
  async deleteWorkItem(projectId: string, workItemId: string): Promise<void> {
    await this.apiCall(
      async () => {
        await this.client.delete(
          `/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${workItemId}/`,
        );
      },
      `deleting work item ${workItemId}`,
    );
  }

  /** Update an existing work item in a project. */
  async updateWorkItem(
    projectId: string,
    workItemId: string,
    payload: Partial<CreateWorkItemPayload>,
  ): Promise<PlaneWorkItem> {
    return this.apiCall(
      async () => {
        const { data } = await this.client.patch<PlaneWorkItem>(
          `/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${workItemId}/`,
          payload,
        );
        return data;
      },
      `updating work item ${workItemId}`,
    );
  }

  /** List comments on a work item. Returns external_ids of existing comments. */
  async listCommentExternalIds(projectId: string, workItemId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    let cursor: string | undefined;

    for (;;) {
      const page = await this.apiCall(
        async () => {
          const { data } = await this.client.get<PlaneApiResponse<PlaneComment>>(
            `/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${workItemId}/comments/`,
            { params: cursor ? { cursor } : {} },
          );
          return data;
        },
        `listing comments for ${workItemId}`,
      );

      const items = Array.isArray(page) ? page : page.results ?? [];
      for (const c of items) {
        if (c.external_id && c.external_source === 'jira-importer') {
          ids.add(c.external_id);
        }
      }

      if (!Array.isArray(page) && page.next_page_results && page.next_cursor) {
        cursor = page.next_cursor;
      } else {
        break;
      }
    }

    return ids;
  }

  /** List attachment external_ids on a work item. */
  async listAttachmentExternalIds(projectId: string, workItemId: string): Promise<Set<string>> {
    const ids = new Set<string>();

    const items = await this.apiCall(
      async () => {
        const { data } = await this.client.get<PlaneAttachment[]>(
          `/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${workItemId}/attachments/`,
        );
        return data;
      },
      `listing attachments for ${workItemId}`,
    );

    for (const a of items) {
      if (a.external_id && a.external_source === 'jira-importer') {
        ids.add(a.external_id);
      }
    }

    return ids;
  }

  /** Create a work item in a project. */
  async createWorkItem(
    projectId: string,
    payload: CreateWorkItemPayload,
  ): Promise<PlaneWorkItem> {
    return this.apiCall(
      async () => {
        const { data } = await this.client.post<PlaneWorkItem>(
          `/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/`,
          payload,
        );
        return data;
      },
      `creating work item "${payload.name}"`,
    );
  }

  // ── Comments ─────────────────────────────────────────────────────────────

  /** Add a comment to a work item. */
  async addComment(
    projectId: string,
    workItemId: string,
    payload: CreateCommentPayload,
  ): Promise<PlaneComment> {
    return this.apiCall(
      async () => {
        const { data } = await this.client.post<PlaneComment>(
          `/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${workItemId}/comments/`,
          payload,
        );
        return data;
      },
      `adding comment to work item ${workItemId}`,
    );
  }

  // ── Attachments ──────────────────────────────────────────────────────────

  /**
   * Upload an attachment to a work item.
   *
   * Three-step process:
   * 1. Get upload credentials (presigned POST)
   * 2. Upload file to storage (S3 / MinIO)
   * 3. Confirm upload completion
   *
   * Each step is individually retried on transient failures.
   */
  async uploadAttachment(
    projectId: string,
    workItemId: string,
    fileBuffer: Buffer,
    filename: string,
    mimeType: string,
    size: number,
    external: ExternalMeta = EMPTY_EXTERNAL_META,
  ): Promise<PlaneAttachment> {
    // Step 1: Get upload credentials. If a previous run created the
    // FileAsset row but failed to upload the bytes (e.g. the server's
    // FILE_SIZE_LIMIT was too low and S3 returned EntityTooLarge),
    // the row is left orphaned (`is_uploaded=false`) and a re-POST
    // returns 409 with the existing asset id. Plane's API has no
    // way to resume an upload for an existing asset — but it does
    // expose DELETE, so on conflict: delete the orphaned row and
    // POST again. This is safe under our usage because the importer
    // owns `external_source = "jira-importer"` and is the only thing
    // creating these rows.
    const postCredentials = async () =>
      this.client.post<PlaneUploadCredentials>(
        `/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${workItemId}/attachments/`,
        { name: filename, type: mimeType, size, ...external },
      );

    // Run the POST through withRetry directly (not apiCall) so we
    // can inspect the raw AxiosError on 409 — apiCall stringifies
    // errors before throwing, which loses the structured response.
    let credentials: PlaneUploadCredentials;
    try {
      credentials = await withRetry(
        async () => {
          await this.rateLimiter.wait();
          const { data } = await postCredentials();
          return data;
        },
        {
          maxRetries: this.maxRetries,
          context: `getting upload credentials for "${filename}"`,
        },
      );
    } catch (err) {
      const e = err as { response?: { status?: number; data?: { id?: string } } };
      const orphanId = e.response?.status === 409 ? e.response.data?.id : undefined;
      if (!orphanId || !external.external_id) {
        // Not the 409-orphan case; let apiCall's normal handler stringify.
        this.handleError(err, `getting upload credentials for "${filename}"`);
      }
      console.log(
        `    Orphaned attachment row for "${filename}" (asset_id=${orphanId}); deleting and retrying`,
      );
      await this.apiCall(
        async () => {
          await this.client.delete(
            `/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${workItemId}/attachments/${orphanId}/`,
          );
        },
        `deleting orphaned attachment ${orphanId}`,
      );
      credentials = await this.apiCall(
        async () => {
          const { data } = await postCredentials();
          return data;
        },
        `re-getting upload credentials for "${filename}"`,
      );
    }

    const assetId = credentials.asset_id ?? credentials.id ?? '';
    const uploadData = credentials.upload_data;

    // Step 2: Upload file to storage via presigned form fields
    if (uploadData?.url && uploadData.fields) {
      await withRetry(
        async () => {
          const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
          const parts: string[] = [];

          for (const [key, value] of Object.entries(uploadData.fields)) {
            parts.push(
              `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
            );
          }

          parts.push(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
          );

          const header = Buffer.from(parts.join(''));
          const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
          const body = Buffer.concat([header, fileBuffer, footer]);

          await axios.post(uploadData.url, body, {
            headers: {
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
              'Content-Length': String(body.length),
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 120_000,
          });
        },
        { maxRetries: this.maxRetries, context: `uploading "${filename}" to storage` },
      );
    }

    // Step 3: Confirm upload
    return this.apiCall(
      async () => {
        const { data } = await this.client.patch<PlaneAttachment>(
          `/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${workItemId}/attachments/${assetId}/`,
        );
        return data;
      },
      `confirming upload for "${filename}"`,
    );
  }

  // ── Internal Helpers ─────────────────────────────────────────────────────

  /**
   * Execute an API call with rate limiting and retry.
   *
   * Waits for the rate limiter before each attempt, retries transient
   * failures with exponential backoff, and formats errors via
   * {@link handleError} when all retries are exhausted.
   */
  private async apiCall<T>(fn: () => Promise<T>, context: string): Promise<T> {
    try {
      return await withRetry(
        async () => {
          await this.rateLimiter.wait();
          return fn();
        },
        { maxRetries: this.maxRetries, context },
      );
    } catch (err: unknown) {
      this.handleError(err, context);
    }
  }

  /**
   * Translate Axios errors into human-readable `Error` instances.
   *
   * Always throws — the `never` return type lets callers skip an explicit
   * return after the catch block.
   */
  private handleError(err: unknown, context: string): never {
    if (axios.isAxiosError(err) && err.response) {
      const { status, data } = err.response;
      const msg = typeof data === 'string' ? data : JSON.stringify(data);
      throw new Error(`Plane API error ${status} while ${context}: ${msg}`);
    }

    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Network error while ${context}: ${message}`);
  }
}
