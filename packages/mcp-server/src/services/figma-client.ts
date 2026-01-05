/**
 * Figma REST API Client
 *
 * Provides read-only access to Figma files via the REST API.
 * Supports file structure, components, styles, comments, and exports.
 */

export interface FigmaConfig {
  accessToken: string;
}

export interface FigmaFile {
  name: string;
  lastModified: string;
  thumbnailUrl: string;
  version: string;
  document: FigmaNode;
  components: Record<string, FigmaComponent>;
  styles: Record<string, FigmaStyle>;
}

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  [key: string]: unknown;
}

export interface FigmaComponent {
  key: string;
  name: string;
  description: string;
  documentationLinks?: string[];
}

export interface FigmaStyle {
  key: string;
  name: string;
  styleType: string;
  description: string;
}

export interface FigmaComment {
  id: string;
  message: string;
  created_at: string;
  user: {
    handle: string;
    img_url: string;
  };
  order_id?: string;
  parent_id?: string;
  resolved_at?: string | null;
}

export interface FigmaExportSettings {
  format: 'jpg' | 'png' | 'svg' | 'pdf';
  scale?: number;
}

const FIGMA_API_BASE = 'https://api.figma.com/v1';

export class FigmaClient {
  private accessToken: string;

  constructor(config: FigmaConfig) {
    this.accessToken = config.accessToken;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${FIGMA_API_BASE}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'X-Figma-Token': this.accessToken,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Figma API error (${response.status}): ${error}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get file metadata and structure
   */
  async getFile(
    fileKey: string,
    options: { depth?: number; nodeId?: string } = {}
  ): Promise<FigmaFile> {
    const params = new URLSearchParams();
    if (options.depth !== undefined) {
      params.set('depth', String(options.depth));
    }
    if (options.nodeId) {
      params.set('ids', options.nodeId);
    }

    const query = params.toString();
    const endpoint = `/files/${fileKey}${query ? `?${query}` : ''}`;
    return this.request<FigmaFile>(endpoint);
  }

  /**
   * Get specific nodes from a file
   */
  async getNodes(
    fileKey: string,
    nodeIds: string[],
    options: { depth?: number } = {}
  ): Promise<{ nodes: Record<string, { document: FigmaNode }> }> {
    const params = new URLSearchParams();
    params.set('ids', nodeIds.join(','));
    if (options.depth !== undefined) {
      params.set('depth', String(options.depth));
    }

    return this.request(`/files/${fileKey}/nodes?${params.toString()}`);
  }

  /**
   * Get file components
   */
  async getComponents(fileKey: string): Promise<{
    meta: { components: FigmaComponent[] };
  }> {
    return this.request(`/files/${fileKey}/components`);
  }

  /**
   * Get file styles
   */
  async getStyles(fileKey: string): Promise<{
    meta: { styles: FigmaStyle[] };
  }> {
    return this.request(`/files/${fileKey}/styles`);
  }

  /**
   * Get file comments
   */
  async getComments(fileKey: string): Promise<{ comments: FigmaComment[] }> {
    return this.request(`/files/${fileKey}/comments`);
  }

  /**
   * Post a comment
   */
  async postComment(
    fileKey: string,
    message: string,
    options: { nodeId?: string; x?: number; y?: number } = {}
  ): Promise<FigmaComment> {
    const body: Record<string, unknown> = { message };

    if (options.nodeId) {
      body.client_meta = {
        node_id: options.nodeId,
        node_offset: { x: options.x || 0, y: options.y || 0 },
      };
    }

    return this.request(`/files/${fileKey}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /**
   * Get image URLs for nodes
   */
  async getImages(
    fileKey: string,
    nodeIds: string[],
    options: FigmaExportSettings = { format: 'png' }
  ): Promise<{ images: Record<string, string> }> {
    const params = new URLSearchParams();
    params.set('ids', nodeIds.join(','));
    params.set('format', options.format);
    if (options.scale) {
      params.set('scale', String(options.scale));
    }

    return this.request(`/images/${fileKey}?${params.toString()}`);
  }

  /**
   * Get team projects
   */
  async getTeamProjects(teamId: string): Promise<{
    projects: Array<{ id: string; name: string }>;
  }> {
    return this.request(`/teams/${teamId}/projects`);
  }

  /**
   * Get project files
   */
  async getProjectFiles(projectId: string): Promise<{
    files: Array<{ key: string; name: string; thumbnail_url: string }>;
  }> {
    return this.request(`/projects/${projectId}/files`);
  }
}

let clientInstance: FigmaClient | null = null;

/**
 * Get or create Figma client instance
 */
export function getFigmaClient(): FigmaClient {
  if (!clientInstance) {
    const token = process.env.FIGMA_ACCESS_TOKEN;
    if (!token) {
      throw new Error(
        'FIGMA_ACCESS_TOKEN environment variable is required. ' +
          'Get your token from Figma Settings > Personal Access Tokens.'
      );
    }
    clientInstance = new FigmaClient({ accessToken: token });
  }
  return clientInstance;
}

/**
 * Set Figma client (for testing or custom configuration)
 */
export function setFigmaClient(client: FigmaClient): void {
  clientInstance = client;
}
