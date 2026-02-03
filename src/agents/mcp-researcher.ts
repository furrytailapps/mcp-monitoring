import { readFile } from 'fs/promises';
import { join } from 'path';
import { callLLM } from '../llm-client.js';
import { type McpInfo } from '../discovery.js';

export interface McpDependency {
  api: string;
  endpoints: string[];
  critical: boolean;
}

export interface McpResearcherOutput {
  mcp: string;
  uses: McpDependency[];
  purpose: string;
}

export interface McpResearcherCache {
  [mcpName: string]: {
    data: McpResearcherOutput;
    timestamp: string;
  };
}

const CACHE_DURATION_DAYS = 30;

const SYSTEM_PROMPT = `You are analyzing an MCP (Model Context Protocol) server to understand what upstream APIs it uses.

MCP servers wrap external APIs to make them available to AI assistants. Your job is to identify:
1. What external APIs the MCP depends on
2. What endpoints or features it uses from each API
3. How critical each dependency is (would the MCP break without it?)

Analyze the CLAUDE.md documentation and source code snippets provided.

Respond with a JSON object in this exact format:
{
  "mcp": "mcp-name",
  "uses": [
    {
      "api": "API Name (e.g., SMHI Forecast API)",
      "endpoints": ["/path/to/endpoint", "/another/endpoint"],
      "critical": true
    }
  ],
  "purpose": "Brief description of what this MCP does"
}

Focus on external HTTP APIs, not internal code dependencies.`;

/**
 * Analyze an MCP to understand its API dependencies
 */
export async function analyzeMcpDependencies(
  mcpInfo: McpInfo,
  cache?: McpResearcherCache
): Promise<McpResearcherOutput> {
  // Check cache first
  if (cache && cache[mcpInfo.name]) {
    const cached = cache[mcpInfo.name];
    const cacheAge = Date.now() - new Date(cached.timestamp).getTime();
    const maxAge = CACHE_DURATION_DAYS * 24 * 60 * 60 * 1000;

    if (cacheAge < maxAge) {
      return cached.data;
    }
  }

  // Read CLAUDE.md
  let claudeMdContent = '';
  try {
    claudeMdContent = await readFile(join(mcpInfo.path, 'CLAUDE.md'), 'utf-8');
  } catch {
    claudeMdContent = 'CLAUDE.md not found';
  }

  // Read key source files (limit to avoid token overflow)
  const sourceSnippets: string[] = [];
  const clientsPath = join(mcpInfo.path, 'src', 'clients');
  const toolsPath = join(mcpInfo.path, 'src', 'tools');

  for (const searchPath of [clientsPath, toolsPath]) {
    try {
      const { readdir } = await import('fs/promises');
      const files = await readdir(searchPath);
      for (const file of files.slice(0, 3)) {
        if (file.endsWith('.ts')) {
          const content = await readFile(join(searchPath, file), 'utf-8');
          // Extract URL patterns and fetch calls
          const relevantLines = content
            .split('\n')
            .filter(
              (line) =>
                line.includes('http') ||
                line.includes('fetch') ||
                line.includes('API') ||
                line.includes('endpoint')
            )
            .slice(0, 20)
            .join('\n');
          if (relevantLines) {
            sourceSnippets.push(`// ${file}\n${relevantLines}`);
          }
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  const userMessage = `Analyze this MCP server (${mcpInfo.name}) to identify its upstream API dependencies:

## CLAUDE.md
${claudeMdContent.slice(0, 5000)}

## Source Code Snippets
${sourceSnippets.join('\n\n').slice(0, 5000)}

## Discovered Upstream APIs (from code scanning)
${mcpInfo.upstreamApis.map((api) => `- ${api.name}: ${api.baseUrl}`).join('\n')}

Extract the API dependencies and return as JSON.`;

  const response = await callLLM<McpResearcherOutput>(SYSTEM_PROMPT, userMessage);

  if (!response.success || !response.data) {
    console.error(`MCP Researcher error for ${mcpInfo.name}: ${response.error}`);
    // Return a basic result based on discovered APIs
    return {
      mcp: mcpInfo.name,
      uses: mcpInfo.upstreamApis.map((api) => ({
        api: api.name,
        endpoints: [],
        critical: true,
      })),
      purpose: mcpInfo.useCase || 'Unknown',
    };
  }

  return {
    mcp: mcpInfo.name,
    uses: response.data.uses,
    purpose: response.data.purpose,
  };
}

/**
 * Analyze all MCPs and return their dependencies
 */
export async function analyzeAllMcps(
  mcps: McpInfo[],
  cache?: McpResearcherCache
): Promise<{ results: McpResearcherOutput[]; updatedCache: McpResearcherCache }> {
  const results: McpResearcherOutput[] = [];
  const updatedCache: McpResearcherCache = { ...cache };

  for (const mcp of mcps) {
    const result = await analyzeMcpDependencies(mcp, cache);
    results.push(result);

    // Update cache
    updatedCache[mcp.name] = {
      data: result,
      timestamp: new Date().toISOString(),
    };
  }

  return { results, updatedCache };
}
