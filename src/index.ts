#!/usr/bin/env node

import { join } from 'path';
import { discoverMcps, getRepoRoot } from './discovery.js';
import {
  checkSources,
  groupChangesByProvider,
  saveCheckState,
} from './source-checker.js';
import { analyzeProviderPages, type ApiResearcherOutput } from './agents/api-researcher.js';
import {
  analyzeAllMcps,
  type McpResearcherOutput,
} from './agents/mcp-researcher.js';
import { decideAction, type EngineerOutput } from './agents/engineer.js';
import { notifyChanges, sendTestNotification, formatConsoleReport } from './slack-notifier.js';
import { isConfigured as isLLMConfigured } from './llm-client.js';

const COMMANDS = ['discover', 'check-sources', 'check', 'notify-test', 'help'];

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  if (!COMMANDS.includes(command)) {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }

  const repoRoot = getRepoRoot();
  const configDir = join(repoRoot, 'monitoring', 'config');
  const stateDir = join(repoRoot, 'monitoring', 'state');

  switch (command) {
    case 'discover':
      await runDiscover(repoRoot);
      break;

    case 'check-sources':
      await runCheckSources(configDir, stateDir);
      break;

    case 'check':
      await runFullCheck(repoRoot, configDir, stateDir);
      break;

    case 'notify-test':
      await runNotifyTest();
      break;

    case 'help':
    default:
      printHelp();
      break;
  }
}

async function runDiscover(repoRoot: string) {
  console.log('Discovering MCPs...\n');

  const mcps = await discoverMcps(repoRoot);

  console.log(`Found ${mcps.length} MCP(s):\n`);

  for (const mcp of mcps) {
    console.log(`┌─ ${mcp.name} ─────────────────────────────────────────────`);
    console.log(`│  Path: ${mcp.path}`);
    console.log(`│  Use Case: ${mcp.useCase || 'Not specified'}`);
    console.log(`│  Tools: ${mcp.tools.length > 0 ? mcp.tools.join(', ') : 'None found'}`);
    console.log(`│  Upstream APIs:`);
    if (mcp.upstreamApis.length === 0) {
      console.log(`│    None detected`);
    } else {
      const uniqueApis = new Map<string, string>();
      for (const api of mcp.upstreamApis) {
        uniqueApis.set(api.baseUrl, api.name);
      }
      for (const [url, name] of uniqueApis) {
        console.log(`│    - ${name}: ${url}`);
      }
    }
    console.log('└──────────────────────────────────────────────────────────\n');
  }
}

async function runCheckSources(configDir: string, stateDir: string) {
  console.log('Checking sources for changes (hash-based)...\n');

  const { changes } = await checkSources(configDir, stateDir);

  if (changes.length === 0) {
    console.log('No changes detected in monitored sources.');
    return;
  }

  console.log(`Found ${changes.length} change(s):\n`);

  for (const change of changes) {
    const emoji =
      change.changeType === 'unavailable'
        ? '❌'
        : change.changeType === 'new'
          ? '🆕'
          : '📝';

    console.log(`${emoji} ${change.apiName}: ${change.description}`);
    console.log(`   Type: ${change.changeType}`);
    console.log(`   URL: ${change.url}`);
    if (change.content) {
      console.log(`   Content: ${change.content.slice(0, 100)}...`);
    }
    console.log('');
  }

  console.log('\nNote: Run `npm run check` for full LLM analysis of changes.');
}

async function runFullCheck(repoRoot: string, configDir: string, stateDir: string) {
  console.log('Running full check with LLM analysis...\n');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Verify LLM is configured
  if (!isLLMConfigured()) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is not set.');
    console.error('LLM analysis requires a valid API key.');
    console.error('');
    console.error('To set it, run:');
    console.error('  export ANTHROPIC_API_KEY="sk-ant-..."');
    process.exit(1);
  }

  // Step 1: Discover MCPs
  console.log('Step 1/4: Discovering MCPs...');
  const mcps = await discoverMcps(repoRoot);
  console.log(`  Found ${mcps.length} MCP(s)\n`);

  // Step 2: Check sources for changes
  console.log('Step 2/4: Checking sources for changes...');
  const { changes, state } = await checkSources(configDir, stateDir);
  const changedProviders = groupChangesByProvider(changes);
  console.log(`  Found ${changes.length} change(s) across ${changedProviders.size} provider(s)\n`);

  // Step 3: Analyze changes with LLM agents
  let apiChanges: ApiResearcherOutput[] = [];
  let mcpDependencies: McpResearcherOutput[] = [];

  if (changedProviders.size > 0) {
    console.log('Step 3/4: Analyzing changes with LLM...');

    // Agent 1: API Researcher - analyze each provider's changed pages
    console.log('  Running API Researcher agent...');
    for (const [apiKey, providerData] of changedProviders) {
      const result = await analyzeProviderPages(providerData.name, providerData.pages);
      apiChanges.push(result);
      console.log(`    ${providerData.name}: ${result.changes.length} change(s) detected`);
    }

    // Agent 2: MCP Researcher - understand MCP dependencies (uses cache)
    console.log('  Running MCP Researcher agent...');
    const { results, updatedCache } = await analyzeAllMcps(mcps, state.mcpCache);
    mcpDependencies = results;
    state.mcpCache = updatedCache;

    // Save updated cache
    const statePath = join(stateDir, 'last-check.json');
    await saveCheckState(statePath, state);

    for (const mcp of mcpDependencies) {
      console.log(`    ${mcp.mcp}: ${mcp.uses.length} API dependencies`);
    }
    console.log('');
  } else {
    console.log('Step 3/4: No changes to analyze\n');
  }

  // Step 4: Engineer decision
  console.log('Step 4/4: Making action decision...');
  const engineerOutput = await decideAction(apiChanges, mcpDependencies);
  console.log(`  Action: ${engineerOutput.action}`);
  console.log('');

  // Print console report
  console.log(formatConsoleReport(engineerOutput));

  // Send to Slack if configured and action needed
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (webhookUrl) {
    console.log('\nSending report to Slack...');
    const sent = await notifyChanges(webhookUrl, engineerOutput);
    console.log(sent ? 'Report sent.' : 'No report sent (no action needed).');
  } else {
    console.log('\nSkipping Slack notification (SLACK_WEBHOOK_URL not set)');
  }
}

async function runNotifyTest() {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;

  if (!webhookUrl) {
    console.error('Error: SLACK_WEBHOOK_URL environment variable is not set.');
    console.error('');
    console.error('To set it, run:');
    console.error('  export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."');
    process.exit(1);
  }

  console.log('Sending test notification to Slack...');

  const success = await sendTestNotification(webhookUrl);

  if (success) {
    console.log('Test notification sent successfully!');
    console.log('Check your Slack channel for the message.');
  } else {
    console.error('Failed to send test notification.');
    console.error('Please check your webhook URL and try again.');
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
MCP Upstream API Monitor v2 (LLM-Powered)

Monitors upstream API changes for MCP servers using intelligent LLM analysis
and sends Slack notifications when action is needed.

Usage:
  npm run <command>

Commands:
  discover       Scan for MCPs and show their configuration
  check-sources  Check news/docs sources for changes (hash-based only)
  check          Run full analysis (sources + LLM agents + notifications)
  notify-test    Send a test notification to Slack
  help           Show this help message

Environment Variables:
  ANTHROPIC_API_KEY   Required for LLM analysis (check command)
  SLACK_WEBHOOK_URL   Required for Slack notifications

Examples:
  npm run discover           # List all discovered MCPs
  npm run check-sources      # Check for source changes (no LLM)
  npm run check              # Run full check with LLM analysis

  # With environment variables:
  ANTHROPIC_API_KEY="sk-ant-..." SLACK_WEBHOOK_URL="https://hooks.slack.com/..." npm run check

How it works:
  1. Hash-based change detection identifies modified web pages
  2. API Researcher agent extracts API changes from modified pages
  3. MCP Researcher agent understands MCP dependencies (cached 30 days)
  4. Engineer agent decides what action is needed
  5. Notifications sent to Slack if action required
`);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
