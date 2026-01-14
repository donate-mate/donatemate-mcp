/**
 * DonateMate Knowledge Base
 * RAG-powered organizational knowledge system with vector search
 */

// Types
export * from './types/index.js';

// Services
export { DatabaseService, type DatabaseConfig } from './services/database.js';
export { EmbedderService, type EmbedderConfig } from './services/embedder.js';

// Integrations
export {
  BasePlugin,
  PluginRegistry,
  GitHubPlugin,
  JiraPlugin,
  ConfluencePlugin,
  SlackPlugin,
  registerBuiltInPlugins,
  createPluginRegistry,
} from './integrations/index.js';

// Re-export commonly used types for convenience
export type {
  ContentChunk,
  IntegrationPlugin,
  IntegrationConfig,
  SearchQuery,
  SearchResult,
  HealthStatus,
  WebhookRequest,
  IntegrationEvent,
} from './types/index.js';
