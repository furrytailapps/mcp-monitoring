import { callLLM } from '../llm-client.js';
import { type ApiResearcherOutput } from './api-researcher.js';
import { type McpResearcherOutput } from './mcp-researcher.js';

export type ActionType = 'notify' | 'urgent' | 'none';

export interface EngineerOutput {
  action: ActionType;
  summary: string;
  affectedMcps: string[];
  recommendedAction: string;
  details: EngineerDetail[];
}

export interface EngineerDetail {
  mcp: string;
  changes: string[];
  impact: 'high' | 'medium' | 'low';
}

const SYSTEM_PROMPT = `You are a software engineer reviewing API changes to determine their impact on MCP servers.

Given:
1. API changes detected from provider documentation/news pages
2. MCP server dependencies (what APIs each MCP uses)

Your job is to:
1. Match API changes to affected MCPs
2. Determine if any action is needed
3. Provide a clear summary and recommendation

Action levels:
- "urgent": Breaking changes or deprecations that require immediate attention
- "notify": Changes worth knowing about but not immediately critical
- "none": No actionable changes (either no changes detected, or changes don't affect any MCPs)

Consider:
- Is the change relevant to any MCP's dependencies?
- How critical is the affected API to the MCP?
- What's the timeline for action (if any)?

Respond with a JSON object in this exact format:
{
  "action": "urgent|notify|none",
  "summary": "One-sentence summary of the situation",
  "affectedMcps": ["mcp-name-1", "mcp-name-2"],
  "recommendedAction": "What the developer should do (or 'No action needed')",
  "details": [
    {
      "mcp": "mcp-name",
      "changes": ["Brief description of relevant change"],
      "impact": "high|medium|low"
    }
  ]
}

If no changes affect any MCPs, set action to "none" with an appropriate summary.`;

/**
 * Analyze API changes against MCP dependencies and decide on action
 */
export async function decideAction(
  apiChanges: ApiResearcherOutput[],
  mcpDependencies: McpResearcherOutput[]
): Promise<EngineerOutput> {
  // Check if there are any changes to analyze
  const allChanges = apiChanges.flatMap((a) => a.changes);
  if (allChanges.length === 0) {
    return {
      action: 'none',
      summary: 'No API changes detected in monitored sources.',
      affectedMcps: [],
      recommendedAction: 'No action needed',
      details: [],
    };
  }

  const userMessage = `Analyze these API changes and determine their impact on the MCP servers:

## API Changes Detected

${apiChanges
  .map(
    (provider) => `### ${provider.provider}
${
  provider.noChangesDetected
    ? 'No changes detected'
    : provider.changes
        .map(
          (c) => `- **${c.title}** (${c.type}, ${c.relevance} relevance)
  ${c.summary}
  Source: ${c.sourceUrl}${c.date ? ` | Date: ${c.date}` : ''}`
        )
        .join('\n')
}`
  )
  .join('\n\n')}

## MCP Server Dependencies

${mcpDependencies
  .map(
    (mcp) => `### ${mcp.mcp}
Purpose: ${mcp.purpose}
Dependencies:
${mcp.uses.map((u) => `- ${u.api}${u.critical ? ' (critical)' : ''}: ${u.endpoints.join(', ') || 'general usage'}`).join('\n')}`
  )
  .join('\n\n')}

Based on this information, determine what action is needed and return as JSON.`;

  const response = await callLLM<EngineerOutput>(SYSTEM_PROMPT, userMessage);

  if (!response.success || !response.data) {
    console.error(`Engineer error: ${response.error}`);
    // Return a safe fallback that prompts manual review
    return {
      action: 'notify',
      summary: `${allChanges.length} API change(s) detected but automated analysis failed. Manual review recommended.`,
      affectedMcps: [],
      recommendedAction: 'Review API changes manually',
      details: [],
    };
  }

  return response.data;
}
