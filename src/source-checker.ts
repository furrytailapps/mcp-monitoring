import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { parse as parseYaml } from 'yaml';
import { type McpResearcherCache } from './agents/mcp-researcher.js';

export interface SourceConfig {
  sources: Record<string, SourceEntry>;
}

export interface SourceEntry {
  name: string;
  web_pages: WebPageEntry[];
}

export interface WebPageEntry {
  url: string;
  description: string;
}

export interface CheckState {
  sources: Record<string, SourceCheckState>;
  mcpCache?: McpResearcherCache;
  lastCheck: string | null;
}

export interface SourceCheckState {
  [url: string]: {
    hash: string;
    lastChecked: string;
    status: number;
  };
}

export interface SourceChange {
  apiKey: string;
  apiName: string;
  url: string;
  description: string;
  changeType: 'new' | 'modified' | 'unavailable';
  content?: string; // Page content for LLM analysis (only on modified/new)
  previousHash?: string;
  currentHash?: string;
  previousStatus?: number;
  currentStatus?: number;
}

const TIMEOUT_MS = 30000;

/**
 * Load source configuration from sources.yaml
 */
export async function loadSourceConfig(configPath: string): Promise<SourceConfig> {
  const content = await readFile(configPath, 'utf-8');
  return parseYaml(content) as SourceConfig;
}

/**
 * Load previous check state
 */
export async function loadCheckState(statePath: string): Promise<CheckState> {
  try {
    const content = await readFile(statePath, 'utf-8');
    return JSON.parse(content) as CheckState;
  } catch {
    return {
      sources: {},
      lastCheck: null,
    };
  }
}

/**
 * Save check state
 */
export async function saveCheckState(statePath: string, state: CheckState): Promise<void> {
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

/**
 * Check all sources for changes
 * Returns changes with page content for LLM analysis
 */
export async function checkSources(
  configDir: string,
  stateDir: string
): Promise<{ changes: SourceChange[]; state: CheckState }> {
  const configPath = join(configDir, 'sources.yaml');
  const statePath = join(stateDir, 'last-check.json');

  const config = await loadSourceConfig(configPath);
  const state = await loadCheckState(statePath);

  const changes: SourceChange[] = [];

  for (const [apiKey, source] of Object.entries(config.sources)) {
    if (!state.sources[apiKey]) {
      state.sources[apiKey] = {};
    }

    for (const pageEntry of source.web_pages) {
      const change = await checkSingleSource(
        apiKey,
        source.name,
        pageEntry,
        state.sources[apiKey]
      );

      if (change) {
        changes.push(change);
      }
    }
  }

  // Update state
  state.lastCheck = new Date().toISOString();
  await saveCheckState(statePath, state);

  return { changes, state };
}

async function checkSingleSource(
  apiKey: string,
  apiName: string,
  pageEntry: WebPageEntry,
  sourceState: SourceCheckState
): Promise<SourceChange | null> {
  const { url, description } = pageEntry;
  const previousCheck = sourceState[url];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'MCP-Monitor/2.0 (API change monitoring)',
      },
    });

    clearTimeout(timeout);

    const content = await response.text();
    const hash = hashContent(content);
    const textContent = extractTextContent(content);

    // Update state
    sourceState[url] = {
      hash,
      lastChecked: new Date().toISOString(),
      status: response.status,
    };

    // Check for changes
    if (!previousCheck) {
      // First time checking this URL - include content for baseline analysis
      return {
        apiKey,
        apiName,
        url,
        description,
        changeType: 'new',
        content: textContent,
        currentHash: hash,
        currentStatus: response.status,
      };
    }

    if (previousCheck.hash !== hash) {
      // Content changed - include content for LLM analysis
      return {
        apiKey,
        apiName,
        url,
        description,
        changeType: 'modified',
        content: textContent,
        previousHash: previousCheck.hash,
        currentHash: hash,
        previousStatus: previousCheck.status,
        currentStatus: response.status,
      };
    }

    // No change
    return null;
  } catch (error) {
    // URL unavailable
    sourceState[url] = {
      hash: '',
      lastChecked: new Date().toISOString(),
      status: 0,
    };

    if (previousCheck && previousCheck.status !== 0) {
      return {
        apiKey,
        apiName,
        url,
        description,
        changeType: 'unavailable',
        previousStatus: previousCheck.status,
        currentStatus: 0,
      };
    }

    return null;
  }
}

function hashContent(content: string): string {
  // Normalize content to ignore minor formatting changes
  const normalized = content
    .replace(/\s+/g, ' ')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, '[timestamp]')
    .trim();

  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Extract text content from HTML for LLM analysis
 */
function extractTextContent(html: string): string {
  // Remove script and style tags
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode HTML entities
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');

  // Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * Get pages with content for LLM analysis (only changed pages)
 * Groups by API provider
 */
export function groupChangesByProvider(
  changes: SourceChange[]
): Map<string, { name: string; pages: Array<{ url: string; content: string }> }> {
  const grouped = new Map<
    string,
    { name: string; pages: Array<{ url: string; content: string }> }
  >();

  for (const change of changes) {
    if (!change.content) continue; // Skip unavailable pages

    if (!grouped.has(change.apiKey)) {
      grouped.set(change.apiKey, { name: change.apiName, pages: [] });
    }

    grouped.get(change.apiKey)!.pages.push({
      url: change.url,
      content: change.content,
    });
  }

  return grouped;
}
