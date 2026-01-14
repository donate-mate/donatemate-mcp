/**
 * Plugin Registry - Manages integration plugins dynamically
 */

import type {
  IntegrationPlugin,
  IntegrationConfig,
  HealthStatus,
} from '../../types/index.js';

export class PluginRegistry {
  private static instance: PluginRegistry | null = null;
  private plugins: Map<string, IntegrationPlugin> = new Map();
  private configs: Map<string, IntegrationConfig> = new Map();
  private initialized: Set<string> = new Set();

  /**
   * Get the singleton instance
   */
  static getInstance(): PluginRegistry {
    if (!PluginRegistry.instance) {
      PluginRegistry.instance = new PluginRegistry();
    }
    return PluginRegistry.instance;
  }

  /**
   * Register a plugin
   */
  register(plugin: IntegrationPlugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin ${plugin.id} is already registered`);
    }
    this.plugins.set(plugin.id, plugin);
  }

  /**
   * Get a registered plugin
   */
  get(id: string): IntegrationPlugin | undefined {
    return this.plugins.get(id);
  }

  /**
   * Get all registered plugins
   */
  getAll(): IntegrationPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get all enabled plugins
   */
  getEnabled(): IntegrationPlugin[] {
    return Array.from(this.plugins.values()).filter((plugin) => {
      const config = this.configs.get(plugin.id);
      return config?.enabled ?? false;
    });
  }

  /**
   * Initialize a plugin with configuration
   */
  async initialize(config: IntegrationConfig): Promise<void> {
    const plugin = this.plugins.get(config.id);
    if (!plugin) {
      throw new Error(`Plugin ${config.id} is not registered`);
    }

    // Validate config against schema
    const validation = plugin.configSchema.safeParse(config.config);
    if (!validation.success) {
      throw new Error(
        `Invalid config for ${config.id}: ${validation.error.message}`
      );
    }

    await plugin.initialize(config);
    this.configs.set(config.id, config);
    this.initialized.add(config.id);
  }

  /**
   * Initialize all plugins from configuration array
   */
  async initializeAll(configs: IntegrationConfig[]): Promise<void> {
    const enabledConfigs = configs.filter((c) => c.enabled);

    await Promise.all(
      enabledConfigs.map(async (config) => {
        try {
          await this.initialize(config);
          console.log(`[PluginRegistry] Initialized ${config.id}`);
        } catch (error) {
          console.error(`[PluginRegistry] Failed to initialize ${config.id}:`, error);
        }
      })
    );
  }

  /**
   * Check if a plugin is initialized
   */
  isInitialized(id: string): boolean {
    return this.initialized.has(id);
  }

  /**
   * Get health status for all plugins
   */
  async healthCheck(): Promise<Record<string, HealthStatus>> {
    const results: Record<string, HealthStatus> = {};

    await Promise.all(
      Array.from(this.plugins.entries()).map(async ([id, plugin]) => {
        try {
          results[id] = await plugin.healthCheck();
        } catch (error) {
          results[id] = {
            healthy: false,
            message: error instanceof Error ? error.message : 'Unknown error',
            lastCheck: new Date(),
          };
        }
      })
    );

    return results;
  }

  /**
   * Shutdown all plugins
   */
  async shutdown(): Promise<void> {
    await Promise.all(
      Array.from(this.plugins.values()).map(async (plugin) => {
        try {
          await plugin.shutdown();
        } catch (error) {
          console.error(`[PluginRegistry] Error shutting down ${plugin.id}:`, error);
        }
      })
    );

    this.initialized.clear();
  }
}

// Singleton instance
export const pluginRegistry = new PluginRegistry();
