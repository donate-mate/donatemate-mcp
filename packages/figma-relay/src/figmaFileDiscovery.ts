export interface FigmaFile {
  key: string;
  name: string;
  thumbnail_url?: string;
  last_modified: string;
  /** Kept for backwards compatibility with the existing MCP response shape. */
  project?: string;
  projectId?: string;
}

interface FigmaFolder {
  id: string;
  name: string;
  parent_folder_id?: string | null;
}

interface FolderNode {
  folder: FigmaFolder;
  path: string;
}

interface FoldersResponse {
  folders?: FigmaFolder[];
}

interface FilesResponse {
  files?: FigmaFile[];
}

export type FigmaApiRequest = <T>(path: string) => Promise<T>;

export interface FileDiscoveryResult {
  files: FigmaFile[];
  folderCount: number;
}

const DEFAULT_MAX_FOLDERS = 1_000;

/**
 * Discover all files reachable from a team using Figma's granular-token folder
 * API. The former v1 project endpoints require the legacy `projects:read`
 * scope, which cannot be granted to newly-created personal access tokens.
 */
export async function discoverTeamFiles(
  teamId: string,
  request: FigmaApiRequest,
  maxFolders = DEFAULT_MAX_FOLDERS
): Promise<FileDiscoveryResult> {
  if (!teamId) {
    throw new Error('FIGMA_TEAM_ID not configured');
  }

  const team = await request<FoldersResponse>(
    `/v2/teams/${encodeURIComponent(teamId)}/folders`
  );
  const queue: FolderNode[] = (team.folders || []).map(folder => ({
    folder,
    path: folder.name,
  }));
  const seenFolderIds = new Set<string>();
  const filesByKey = new Map<string, FigmaFile>();

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (seenFolderIds.has(node.folder.id)) {
      continue;
    }
    if (seenFolderIds.size >= maxFolders) {
      throw new Error(`Figma folder traversal exceeded the ${maxFolders} folder safety limit`);
    }
    seenFolderIds.add(node.folder.id);

    const folderId = encodeURIComponent(node.folder.id);
    const [fileData, childData] = await Promise.all([
      request<FilesResponse>(`/v2/folders/${folderId}/files`),
      request<FoldersResponse>(`/v2/folders/${folderId}/folders`),
    ]);

    for (const file of fileData.files || []) {
      filesByKey.set(file.key, {
        ...file,
        project: node.path,
        projectId: node.folder.id,
      });
    }

    for (const child of childData.folders || []) {
      queue.push({
        folder: child,
        path: `${node.path} / ${child.name}`,
      });
    }
  }

  return {
    files: [...filesByKey.values()],
    folderCount: seenFolderIds.size,
  };
}
