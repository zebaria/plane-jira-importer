import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    dim: vi.fn(),
    heading: vi.fn(),
    item: vi.fn(),
  },
}));

// sleep is used by both RateLimiter and the retry utility
vi.mock('../src/utils/helpers.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

// retry utility uses sleep + log internally (both already mocked above)

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPatch = vi.fn();
const mockDelete = vi.fn();

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      get: mockGet,
      post: mockPost,
      patch: mockPatch,
      delete: mockDelete,
    })),
    isAxiosError: vi.fn(
      (err: unknown) =>
        typeof err === 'object' && err !== null && 'isAxiosError' in err,
    ),
    post: vi.fn(),
  },
}));

import { PlaneClient } from '../src/clients/plane.js';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PlaneClient', () => {
  let client: PlaneClient;

  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockPatch.mockReset();
    mockDelete.mockReset();

    client = new PlaneClient({
      host: 'https://plane.test.com',
      apiKey: 'test-api-key',
      workspaceSlug: 'test-ws',
      rateLimiter: { wait: vi.fn().mockResolvedValue(undefined) },
      maxRetries: 0, // No retries in unit tests for predictable behavior
    });
  });

  // ── listProjects ─────────────────────────────────────────────────────

  describe('listProjects', () => {
    it('handles a flat array response', async () => {
      const projects = [{ id: '1', identifier: 'PROJ', name: 'Project' }];
      mockGet.mockResolvedValueOnce({ data: projects });

      const result = await client.listProjects();

      expect(result).toEqual(projects);
    });

    it('handles paginated responses', async () => {
      mockGet
        .mockResolvedValueOnce({
          data: {
            results: [{ id: '1', identifier: 'P1', name: 'P1' }],
            next_cursor: 'cursor-abc',
            next_page_results: true,
          },
        })
        .mockResolvedValueOnce({
          data: {
            results: [{ id: '2', identifier: 'P2', name: 'P2' }],
          },
        });

      const result = await client.listProjects();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('1');
      expect(result[1].id).toBe('2');
    });
  });

  // ── listStates ───────────────────────────────────────────────────────

  describe('listStates', () => {
    it('returns states for a project', async () => {
      const states = [{ id: 's1', name: 'Todo', group: 'unstarted' }];
      mockGet.mockResolvedValueOnce({ data: states });

      const result = await client.listStates('proj-1');

      expect(result).toEqual(states);
    });
  });

  // ── listLabels ───────────────────────────────────────────────────────

  describe('listLabels', () => {
    it('returns labels for a project', async () => {
      const labels = [{ id: 'l1', name: 'Bug', color: '#ff0000' }];
      mockGet.mockResolvedValueOnce({ data: labels });

      const result = await client.listLabels('proj-1');

      expect(result).toEqual(labels);
    });
  });

  // ── createLabel ──────────────────────────────────────────────────────

  describe('createLabel', () => {
    it('creates a new label', async () => {
      const label = { id: 'l1', name: 'Jira: Bug' };
      mockPost.mockResolvedValueOnce({ data: label });

      const result = await client.createLabel('proj-1', 'Jira: Bug');

      expect(result).toEqual(label);
    });

    it('returns existing label on 409 conflict', async () => {
      mockPost.mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 409 },
      });

      // listLabels call triggered by the 409 handler
      const existing = [
        { id: 'l1', name: 'Jira: Bug' },
        { id: 'l2', name: 'Jira: Story' },
      ];
      mockGet.mockResolvedValueOnce({ data: existing });

      const result = await client.createLabel('proj-1', 'Jira: Bug');

      expect(result).toEqual({ id: 'l1', name: 'Jira: Bug' });
    });
  });

  // ── listMembers ──────────────────────────────────────────────────────

  describe('listMembers', () => {
    it('returns workspace members', async () => {
      const members = [
        { id: 'm1', email: 'alice@example.com', display_name: 'Alice', role: 20 },
      ];
      mockGet.mockResolvedValueOnce({ data: members });

      const result = await client.listMembers();

      expect(result).toEqual(members);
    });
  });

  // ── listWorkItems ────────────────────────────────────────────────────

  describe('listWorkItems', () => {
    it('handles a flat array response', async () => {
      const items = [{ id: 'wi1', name: 'Item 1' }];
      mockGet.mockResolvedValueOnce({ data: items });

      const result = await client.listWorkItems('proj-1');

      expect(result).toEqual(items);
    });

    it('handles paginated work items', async () => {
      mockGet
        .mockResolvedValueOnce({
          data: {
            results: [{ id: 'wi1', name: 'First' }],
            next_cursor: 'c1',
            next_page_results: true,
          },
        })
        .mockResolvedValueOnce({
          data: {
            results: [{ id: 'wi2', name: 'Second' }],
          },
        });

      const result = await client.listWorkItems('proj-1');

      expect(result).toHaveLength(2);
    });
  });

  // ── createWorkItem ───────────────────────────────────────────────────

  describe('createWorkItem', () => {
    it('creates a work item with full payload', async () => {
      const item = { id: 'wi1', name: 'New Issue' };
      mockPost.mockResolvedValueOnce({ data: item });

      const result = await client.createWorkItem('proj-1', {
        name: 'New Issue',
        description_html: '<p>Description</p>',
        priority: 'medium',
        external_id: 'PROJ-1',
        external_source: 'jira-importer',
      });

      expect(result).toEqual(item);
    });
  });

  // ── addComment ───────────────────────────────────────────────────────

  describe('addComment', () => {
    it('adds a comment to a work item', async () => {
      const comment = { id: 'c1', comment_html: '<p>Test comment</p>' };
      mockPost.mockResolvedValueOnce({ data: comment });

      const result = await client.addComment('proj-1', 'wi-1', {
        comment_html: '<p>Test comment</p>',
        external_source: 'jira-importer',
        external_id: 'PROJ-1-comment-100',
      });

      expect(result).toEqual(comment);
    });
  });

  // ── updateWorkItem ────────────────────────────────────────────────────

  describe('updateWorkItem', () => {
    it('updates a work item with partial payload', async () => {
      const updated = { id: 'wi-1', name: 'Updated Issue' };
      mockPatch.mockResolvedValueOnce({ data: updated });

      const result = await client.updateWorkItem('proj-1', 'wi-1', {
        name: 'Updated Issue',
      });

      expect(result).toEqual(updated);
      expect(mockPatch).toHaveBeenCalledWith(
        '/workspaces/test-ws/projects/proj-1/work-items/wi-1/',
        { name: 'Updated Issue' },
      );
    });
  });

  // ── deleteWorkItem ────────────────────────────────────────────────────

  describe('deleteWorkItem', () => {
    it('deletes a work item', async () => {
      mockDelete.mockResolvedValueOnce({ data: {} });

      await client.deleteWorkItem('proj-1', 'wi-1');

      expect(mockDelete).toHaveBeenCalledWith(
        '/workspaces/test-ws/projects/proj-1/work-items/wi-1/',
      );
    });

    it('throws on API errors', async () => {
      mockDelete.mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 404, data: 'Not found' },
      });

      await expect(client.deleteWorkItem('proj-1', 'wi-1')).rejects.toThrow(
        /Plane API error 404.*deleting work item/,
      );
    });
  });

  // ── Error Handling ───────────────────────────────────────────────────

  describe('error handling', () => {
    it('wraps API errors with status and context', async () => {
      mockGet.mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 500, data: 'Internal Server Error' },
      });

      await expect(client.listStates('proj-1')).rejects.toThrow(
        /Plane API error 500.*listing Plane states/,
      );
    });

    it('wraps network errors with context', async () => {
      mockGet.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(client.listStates('proj-1')).rejects.toThrow(
        /Network error.*listing Plane states/,
      );
    });
  });
});
