import { readdir, readFile, stat } from 'fs/promises';
import { join, resolve } from 'path';

export interface McpInfo {
  name: string;
  path: string;
  useCase: string;
  targetAudience: string;
  tools: string[];
  upstreamApis: UpstreamApi[];
}

export interface UpstreamApi {
  name: string;
  baseUrl: string;
  source: string; // file where it was found
}

/**
 * Discovers all MCP projects in the repository
 * Scans for mcp-* directories and extracts metadata from CLAUDE.md and source files
 */
export async function discoverMcps(repoRoot: string): Promise<McpInfo[]> {
  const mcps: McpInfo[] = [];

  // Scan for mcp-* directories
  const entries = await readdir(repoRoot, { withFileTypes: true });
  const mcpDirs = entries.filter(
    (e) => e.isDirectory() && e.name.startsWith('mcp-')
  );

  for (const dir of mcpDirs) {
    const mcpPath = join(repoRoot, dir.name);

    try {
      const info = await extractMcpInfo(mcpPath, dir.name);
      mcps.push(info);
    } catch (error) {
      console.warn(`Warning: Could not extract info from ${dir.name}:`, error);
    }
  }

  return mcps;
}

async function extractMcpInfo(mcpPath: string, name: string): Promise<McpInfo> {
  // Read CLAUDE.md for use case and tools
  const claudeMd = await readClaudeMd(mcpPath);

  // Extract API URLs from source files
  const upstreamApis = await extractApiUrls(mcpPath);

  return {
    name,
    path: mcpPath,
    useCase: claudeMd.useCase,
    targetAudience: claudeMd.targetAudience,
    tools: claudeMd.tools,
    upstreamApis,
  };
}

interface ClaudeMdInfo {
  useCase: string;
  targetAudience: string;
  tools: string[];
}

async function readClaudeMd(mcpPath: string): Promise<ClaudeMdInfo> {
  const claudePath = join(mcpPath, 'CLAUDE.md');

  try {
    const content = await readFile(claudePath, 'utf-8');
    return parseClaudeMd(content);
  } catch {
    return {
      useCase: 'Unknown - CLAUDE.md not found',
      targetAudience: 'Unknown',
      tools: [],
    };
  }
}

function parseClaudeMd(content: string): ClaudeMdInfo {
  let useCase = '';
  let targetAudience = '';
  const tools: string[] = [];

  // Extract use case from description at top (usually after the title)
  const descMatch = content.match(
    /^MCP server (?:wrapping|for)\s+(.+?)(?:\.|$)/im
  );
  if (descMatch) {
    useCase = descMatch[1].trim();
  }

  // Extract target audience section
  const targetMatch = content.match(
    /## Target Audience\s*\n([\s\S]*?)(?=\n##|\n$)/i
  );
  if (targetMatch) {
    targetAudience = targetMatch[1]
      .trim()
      .split('\n')
      .slice(0, 5)
      .join(' ')
      .replace(/[-*]\s*/g, '')
      .trim();
  }

  // Extract tool names from Available Tools table
  const toolMatches = content.matchAll(/\|\s*`([^`]+)`\s*\|/g);
  for (const match of toolMatches) {
    if (
      match[1] &&
      !match[1].startsWith('Tool') &&
      !match[1].includes('Description')
    ) {
      tools.push(match[1]);
    }
  }

  return { useCase, targetAudience, tools };
}

async function extractApiUrls(mcpPath: string): Promise<UpstreamApi[]> {
  const apis: UpstreamApi[] = [];
  const seenUrls = new Set<string>();

  // Check common locations for API URLs
  const searchPaths = [
    'src/clients',
    'src/lib',
    'src/types',
    'src/tools',
    'src',
  ];

  for (const searchPath of searchPaths) {
    const fullPath = join(mcpPath, searchPath);

    try {
      await stat(fullPath);
      const files = await findTsFiles(fullPath);

      for (const file of files) {
        const content = await readFile(file, 'utf-8');
        const foundApis = extractApisFromSource(content, file);

        for (const api of foundApis) {
          if (!seenUrls.has(api.baseUrl)) {
            seenUrls.add(api.baseUrl);
            apis.push(api);
          }
        }
      }
    } catch {
      // Directory doesn't exist, skip
    }
  }

  return apis;
}

async function findTsFiles(dirPath: string): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const subFiles = await findTsFiles(fullPath);
        files.push(...subFiles);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push(fullPath);
      }
    }
  } catch {
    // Ignore read errors
  }

  return files;
}

function extractApisFromSource(content: string, filePath: string): UpstreamApi[] {
  const apis: UpstreamApi[] = [];

  // Match HTTP/HTTPS URLs that look like API endpoints
  // Focus on Swedish government/data APIs
  const urlPatterns = [
    // SMHI
    /https?:\/\/opendata[^'")\s]+smhi\.se[^'")\s]*/g,
    // Trafikverket
    /https?:\/\/[^'")\s]*trafikverket\.se[^'")\s]*/g,
    /https?:\/\/[^'")\s]*trafikinfo[^'")\s]*/g,
    // SGU
    /https?:\/\/[^'")\s]*\.sgu\.se[^'")\s]*/g,
    // Naturvardsverket
    /https?:\/\/[^'")\s]*naturvardsverket\.se[^'")\s]*/g,
    // Generic API URLs
    /https?:\/\/[^'")\s]*\/api\/[^'")\s]*/g,
  ];

  for (const pattern of urlPatterns) {
    const matches = content.matchAll(pattern);

    for (const match of matches) {
      let url = match[0];

      // Clean up the URL
      url = url.replace(/['"`,;)}\]]+$/, '');

      // Extract base URL (remove path params and query strings)
      const baseUrl = extractBaseUrl(url);

      if (baseUrl && isValidApiUrl(baseUrl)) {
        apis.push({
          name: guessApiName(baseUrl),
          baseUrl,
          source: filePath,
        });
      }
    }
  }

  return apis;
}

function extractBaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Return just the origin (protocol + host)
    return parsed.origin;
  } catch {
    return '';
  }
}

function isValidApiUrl(url: string): boolean {
  // Filter out local/test URLs
  if (url.includes('localhost')) return false;
  if (url.includes('127.0.0.1')) return false;
  if (url.includes('vercel.app')) return false;

  return true;
}

function guessApiName(baseUrl: string): string {
  if (baseUrl.includes('smhi')) return 'SMHI Open Data';
  if (baseUrl.includes('trafikverket') || baseUrl.includes('trafikinfo'))
    return 'Trafikverket';
  if (baseUrl.includes('sgu')) return 'SGU';
  if (baseUrl.includes('naturvardsverket')) return 'Naturvardsverket';
  return 'Unknown API';
}

/**
 * Get the repo root directory (one level up from monitoring/)
 */
export function getRepoRoot(): string {
  // This file is at monitoring/src/discovery.ts
  // Repo root is two levels up
  return resolve(import.meta.dirname, '..', '..');
}
