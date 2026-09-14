import { describe, expect, it, vi } from 'vitest';
import { discoverTeamFiles } from '../src/figmaFileDiscovery.js';

describe('discoverTeamFiles', () => {
  it('uses the v2 folder API and recursively discovers nested files', async () => {
    const responses: Record<string, unknown> = {
      '/v2/teams/team-1/folders': {
        folders: [{ id: 'root', name: 'Product', parent_folder_id: null }],
      },
      '/v2/folders/root/files': {
        files: [{ key: 'root-file', name: 'Assets', last_modified: '2026-09-01T00:00:00Z' }],
      },
      '/v2/folders/root/folders': {
        folders: [{ id: 'child', name: 'Mobile', parent_folder_id: 'root' }],
      },
      '/v2/folders/child/files': {
        files: [{ key: 'child-file', name: 'Donation flow', last_modified: '2026-09-02T00:00:00Z' }],
      },
      '/v2/folders/child/folders': { folders: [] },
    };
    const request = vi.fn(async <T>(path: string) => responses[path] as T);

    const result = await discoverTeamFiles('team-1', request);

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/v2/teams/team-1/folders',
      '/v2/folders/root/files',
      '/v2/folders/root/folders',
      '/v2/folders/child/files',
      '/v2/folders/child/folders',
    ]);
    expect(result).toEqual({
      folderCount: 2,
      files: [
        expect.objectContaining({ key: 'root-file', project: 'Product', projectId: 'root' }),
        expect.objectContaining({ key: 'child-file', project: 'Product / Mobile', projectId: 'child' }),
      ],
    });
  });

  it('deduplicates folder cycles and duplicate file keys', async () => {
    const request = vi.fn(async <T>(path: string) => {
      if (path.includes('/teams/')) {
        return { folders: [{ id: 'root', name: 'Root' }] } as T;
      }
      if (path.endsWith('/files')) {
        return { files: [{ key: 'same', name: 'Shared', last_modified: '2026-09-01T00:00:00Z' }] } as T;
      }
      return { folders: [{ id: 'root', name: 'Root' }] } as T;
    });

    const result = await discoverTeamFiles('team-1', request);

    expect(result.folderCount).toBe(1);
    expect(result.files).toHaveLength(1);
  });

  it('fails safely if an unexpectedly large hierarchy is returned', async () => {
    const request = vi.fn(async <T>(path: string) => {
      if (path.includes('/teams/')) {
        return { folders: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }] } as T;
      }
      return path.endsWith('/files') ? ({ files: [] } as T) : ({ folders: [] } as T);
    });

    await expect(discoverTeamFiles('team-1', request, 1)).rejects.toThrow('safety limit');
  });
});
