/**
 * Design Token Service
 *
 * Manages loading, querying, and exporting DonateMate design tokens.
 * Tokens follow the DTCG (Design Token Community Group) format.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface TokenValue {
  $type?: string;
  $value: string | number | Record<string, unknown>;
  $description?: string;
}

export interface TokenGroup {
  [key: string]: TokenValue | TokenGroup;
}

export interface FlattenedToken {
  path: string;
  value: string | number | Record<string, unknown>;
  type?: string;
  description?: string;
}

let cachedTokens: TokenGroup | null = null;

/**
 * Load tokens from the resources directory
 */
export function loadTokens(): TokenGroup {
  if (cachedTokens) {
    return cachedTokens;
  }

  const tokensPath = join(__dirname, '..', 'resources', 'tokens.json');
  const content = readFileSync(tokensPath, 'utf-8');
  cachedTokens = JSON.parse(content) as TokenGroup;
  return cachedTokens;
}

/**
 * Check if an object is a token value (has $value property)
 */
function isTokenValue(obj: unknown): obj is TokenValue {
  return typeof obj === 'object' && obj !== null && '$value' in obj;
}

/**
 * Flatten token tree into a list of path/value pairs
 */
export function flattenTokens(
  tokens: TokenGroup,
  prefix = '',
  category?: string
): FlattenedToken[] {
  const result: FlattenedToken[] = [];

  for (const [key, value] of Object.entries(tokens)) {
    // Skip metadata keys
    if (key.startsWith('$')) continue;

    const path = prefix ? `${prefix}.${key}` : key;

    if (isTokenValue(value)) {
      // Skip if filtering by category and path doesn't match
      if (category && !path.startsWith(category)) continue;

      result.push({
        path,
        value: value.$value,
        type: value.$type,
        description: value.$description,
      });
    } else if (typeof value === 'object' && value !== null) {
      // Recurse into nested groups
      result.push(...flattenTokens(value as TokenGroup, path, category));
    }
  }

  return result;
}

/**
 * Get a specific token by path
 */
export function getToken(path: string): FlattenedToken | null {
  const tokens = loadTokens();
  const parts = path.split('.');
  let current: TokenGroup | TokenValue | undefined = tokens;

  for (const part of parts) {
    if (typeof current !== 'object' || current === null) {
      return null;
    }
    current = (current as TokenGroup)[part];
  }

  if (!isTokenValue(current)) {
    return null;
  }

  return {
    path,
    value: current.$value,
    type: current.$type,
    description: current.$description,
  };
}

/**
 * Resolve token references (e.g., "{global.colors.sky.500}")
 */
export function resolveTokenValue(value: unknown): string | number | Record<string, unknown> {
  if (typeof value !== 'string') {
    return value as string | number | Record<string, unknown>;
  }

  // Check for reference syntax
  const refMatch = value.match(/^\{(.+)\}$/);
  if (!refMatch) {
    return value;
  }

  const refPath = refMatch[1];
  const token = getToken(refPath);
  if (!token) {
    return value; // Return original if reference not found
  }

  // Recursively resolve nested references
  return resolveTokenValue(token.value);
}

/**
 * Search tokens by query string
 */
export function searchTokens(query: string): FlattenedToken[] {
  const tokens = loadTokens();
  const allTokens = flattenTokens(tokens);
  const lowerQuery = query.toLowerCase();

  return allTokens.filter((token) => {
    const pathMatch = token.path.toLowerCase().includes(lowerQuery);
    const valueMatch =
      typeof token.value === 'string' &&
      token.value.toLowerCase().includes(lowerQuery);
    const descMatch =
      token.description?.toLowerCase().includes(lowerQuery) ?? false;

    return pathMatch || valueMatch || descMatch;
  });
}

/**
 * List all available token categories (top-level keys)
 */
export function listCategories(): string[] {
  const tokens = loadTokens();
  return Object.keys(tokens).filter((key) => !key.startsWith('$'));
}

/**
 * Export tokens in different formats
 */
export function exportTokens(
  format: 'css' | 'json' | 'tailwind',
  category?: string
): string {
  const tokens = loadTokens();
  const flatTokens = flattenTokens(tokens, '', category);

  switch (format) {
    case 'css':
      return exportToCss(flatTokens);
    case 'json':
      return JSON.stringify(flatTokens, null, 2);
    case 'tailwind':
      return exportToTailwind(flatTokens);
    default:
      throw new Error(`Unknown format: ${format}`);
  }
}

function exportToCss(tokens: FlattenedToken[]): string {
  const lines = [':root {'];

  for (const token of tokens) {
    const varName = token.path.replace(/\./g, '-');
    const resolvedValue = resolveTokenValue(token.value);
    if (typeof resolvedValue === 'string' || typeof resolvedValue === 'number') {
      lines.push(`  --${varName}: ${resolvedValue};`);
    }
  }

  lines.push('}');
  return lines.join('\n');
}

function exportToTailwind(tokens: FlattenedToken[]): string {
  const config: Record<string, Record<string, string>> = {
    colors: {},
    spacing: {},
    borderRadius: {},
    fontSize: {},
  };

  for (const token of tokens) {
    const resolvedValue = resolveTokenValue(token.value);
    if (typeof resolvedValue !== 'string' && typeof resolvedValue !== 'number') {
      continue;
    }

    // Categorize tokens for Tailwind config
    if (token.path.includes('color') || token.type === 'color') {
      const name = token.path.replace(/\./g, '-');
      config.colors[name] = String(resolvedValue);
    } else if (token.path.includes('spacing') || token.type === 'dimension') {
      const name = token.path.replace(/\./g, '-');
      config.spacing[name] = String(resolvedValue);
    } else if (token.path.includes('radius')) {
      const name = token.path.replace(/\./g, '-');
      config.borderRadius[name] = String(resolvedValue);
    } else if (token.path.includes('font') && token.path.includes('size')) {
      const name = token.path.replace(/\./g, '-');
      config.fontSize[name] = String(resolvedValue);
    }
  }

  return `module.exports = ${JSON.stringify(config, null, 2)}`;
}
