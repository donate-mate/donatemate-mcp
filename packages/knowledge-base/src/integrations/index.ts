/**
 * Integration Plugins Index
 * Exports all available integration plugins
 */

export { BasePlugin } from './core/base-plugin.js';
export { PluginRegistry } from './core/plugin-registry.js';
export { GitHubPlugin } from './github/index.js';
export { JiraPlugin } from './jira/index.js';
export { ConfluencePlugin } from './confluence/index.js';
export { SlackPlugin } from './slack/index.js';

import { PluginRegistry } from './core/plugin-registry.js';
import { GitHubPlugin } from './github/index.js';
import { JiraPlugin } from './jira/index.js';
import { ConfluencePlugin } from './confluence/index.js';
import { SlackPlugin } from './slack/index.js';

/**
 * Register all built-in plugins with the registry
 */
export function registerBuiltInPlugins(registry: PluginRegistry): void {
  registry.register(new GitHubPlugin());
  registry.register(new JiraPlugin());
  registry.register(new ConfluencePlugin());
  registry.register(new SlackPlugin());
}

/**
 * Create a new registry with all built-in plugins registered
 */
export function createPluginRegistry(): PluginRegistry {
  const registry = PluginRegistry.getInstance();
  registerBuiltInPlugins(registry);
  return registry;
}
