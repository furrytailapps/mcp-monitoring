import { callLLM } from '../llm-client.js';
import { type ImpactLevel } from '../types.js';

export type ChangeType = 'deprecation' | 'breaking' | 'new_feature' | 'maintenance' | 'unknown';

export interface ApiChange {
  title: string;
  summary: string;
  type: ChangeType;
  relevance: ImpactLevel;
  sourceUrl: string;
  date: string | null;
}

export interface ApiResearcherOutput {
  provider: string;
  changes: ApiChange[];
  noChangesDetected: boolean;
}

const SYSTEM_PROMPT = `You are an API change researcher. Your job is to analyze web page content from API documentation or news pages and extract any announcements about API changes.

Focus on changes that would affect developers using these APIs:
- Deprecation notices (endpoints being removed, versions being sunset)
- Breaking changes (parameter changes, response format changes, authentication changes)
- New features (new endpoints, new parameters, new data available)
- Maintenance notices (scheduled downtime, migrations)

For each change you find, determine:
- Title: A short descriptive title
- Summary: What developers need to know
- Type: deprecation, breaking, new_feature, maintenance, or unknown
- Relevance: high (action required), medium (should review), low (informational)
- Date: When announced or when it takes effect (if mentioned)

If the page content doesn't contain any API-related changes or announcements, indicate that no changes were detected.

Respond with a JSON object in this exact format:
{
  "provider": "Provider Name",
  "changes": [
    {
      "title": "Change title",
      "summary": "What developers need to know",
      "type": "deprecation|breaking|new_feature|maintenance|unknown",
      "relevance": "high|medium|low",
      "sourceUrl": "URL of the page",
      "date": "2026-02-01 or null if not specified"
    }
  ],
  "noChangesDetected": false
}

If no changes are found, set "noChangesDetected": true and "changes": [].`;

/**
 * Analyze web page content to extract API-relevant changes
 */
export async function analyzeApiChanges(
  provider: string,
  pageUrl: string,
  pageContent: string
): Promise<ApiResearcherOutput> {
  const userMessage = `Analyze this web page content from ${provider} (${pageUrl}) for any API changes or announcements:

---
${pageContent.slice(0, 15000)}
---

Extract any API-related changes and return as JSON.`;

  const response = await callLLM<ApiResearcherOutput>(SYSTEM_PROMPT, userMessage);

  if (!response.success || !response.data) {
    console.error(`API Researcher error: ${response.error}`);
    return {
      provider,
      changes: [],
      noChangesDetected: true,
    };
  }

  // Ensure sourceUrl is set for all changes
  const changes = response.data.changes.map((change) => ({
    ...change,
    sourceUrl: change.sourceUrl || pageUrl,
  }));

  return {
    provider,
    changes,
    noChangesDetected: response.data.noChangesDetected || changes.length === 0,
  };
}

/**
 * Analyze multiple pages for a single provider
 */
export async function analyzeProviderPages(
  provider: string,
  pages: Array<{ url: string; content: string }>
): Promise<ApiResearcherOutput> {
  const allChanges: ApiChange[] = [];

  for (const page of pages) {
    const result = await analyzeApiChanges(provider, page.url, page.content);
    allChanges.push(...result.changes);
  }

  // Deduplicate changes by title
  const uniqueChanges = allChanges.filter(
    (change, index, self) =>
      index === self.findIndex((c) => c.title === change.title)
  );

  return {
    provider,
    changes: uniqueChanges,
    noChangesDetected: uniqueChanges.length === 0,
  };
}
