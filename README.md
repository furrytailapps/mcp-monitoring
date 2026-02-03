# MCP Upstream API Monitor v2

Monitors upstream API changes for MCP servers using intelligent LLM analysis and sends Slack notifications when actionable changes are detected.

## Features

- **Auto-Discovery**: Automatically finds MCPs by scanning for `mcp-*` directories
- **Hash-Based Change Detection**: Efficiently detects when web pages have changed
- **LLM-Powered Analysis**: Uses Claude to intelligently analyze changes and determine impact
- **3-Agent Pipeline**: API Researcher → MCP Researcher → Engineer decision
- **Smart Caching**: MCP dependency analysis cached for 30 days
- **Slack Notifications**: Sends alerts only when action is needed

## Quick Start

```bash
# Install dependencies
cd monitoring
npm install

# Discover MCPs in the repo
npm run discover

# Check sources for changes (hash-based only)
npm run check-sources

# Run full check with LLM analysis
ANTHROPIC_API_KEY="sk-ant-..." npm run check
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run discover` | List all MCPs and their upstream APIs |
| `npm run check-sources` | Check sources for changes (hash-based, no LLM) |
| `npm run check` | Run full analysis with LLM agents |
| `npm run notify-test` | Send a test Slack notification |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | For `check` | Claude API key for LLM analysis |
| `SLACK_WEBHOOK_URL` | For notifications | Slack incoming webhook URL |

## How It Works

The v2 monitor uses a 3-agent LLM pipeline:

1. **Hash-Based Change Detection**: Fetches web pages, computes hashes, detects changes efficiently

2. **Agent 1 - API Researcher**: Analyzes changed page content to extract API-relevant announcements (deprecations, breaking changes, new features, maintenance)

3. **Agent 2 - MCP Researcher**: Understands what APIs each MCP depends on by reading CLAUDE.md and source code (results cached for 30 days)

4. **Agent 3 - Engineer**: Decides what action is needed based on API changes and MCP dependencies

5. **Notification**: Sends to Slack only if action is required (urgent or notify level)

## Slack Setup

1. **Create a Slack App**:
   - Go to https://api.slack.com/apps
   - Click "Create New App" → "From scratch"
   - Name it "MCP Monitor" and select your workspace

2. **Enable Incoming Webhooks**:
   - In your app settings, go to "Incoming Webhooks"
   - Toggle "Activate Incoming Webhooks" to On
   - Click "Add New Webhook to Workspace"
   - Select the channel for notifications
   - Copy the webhook URL

3. **Configure**:
   ```bash
   export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
   export ANTHROPIC_API_KEY="sk-ant-..."
   npm run check
   ```

4. **Test**:
   ```bash
   npm run notify-test
   ```

## Configuration

### Source Registry (`config/sources.yaml`)

```yaml
sources:
  my-api:
    name: "My API"
    web_pages:
      - url: "https://api.example.com/docs"
        description: "API documentation"
      - url: "https://api.example.com/news"
        description: "Release notes"
```

### State File (`state/last-check.json`)

Stores:
- Content hashes for change detection
- MCP researcher cache (30-day TTL)
- Last check timestamp

## Architecture

```
monitoring/
├── config/
│   └── sources.yaml           # Web pages to monitor
├── state/
│   └── last-check.json        # Hashes + MCP researcher cache
├── src/
│   ├── agents/
│   │   ├── api-researcher.ts  # LLM: Extracts API changes from pages
│   │   ├── mcp-researcher.ts  # LLM: Understands MCP dependencies
│   │   └── engineer.ts        # LLM: Decides action needed
│   ├── llm-client.ts          # Claude API wrapper
│   ├── discovery.ts           # Auto-discover MCPs
│   ├── source-checker.ts      # Hash-based change detection
│   ├── slack-notifier.ts      # Send Slack notifications
│   └── index.ts               # CLI entry point
└── README.md
```

## Cost

Using Claude Sonnet for all 3 agents:
- Estimated: ~$0.15-0.30 per full run (4 APIs × 3 agents)
- MCP researcher results cached to minimize repeated calls
- Only analyzes pages that have actually changed

## Action Levels

| Level | Description | Notification |
|-------|-------------|--------------|
| **Urgent** | Breaking changes, deprecations requiring immediate action | Yes |
| **Notify** | Changes worth knowing about | Yes |
| **None** | No actionable changes | No |

## Troubleshooting

**"ANTHROPIC_API_KEY not set":**
- The `check` command requires an API key for LLM analysis
- Use `check-sources` for hash-based detection without LLM

**Slack notification not sending:**
- Verify `SLACK_WEBHOOK_URL` is set correctly
- Run `npm run notify-test` to test the webhook
- Notifications only sent when action is needed (not "none")

**MCP not being discovered:**
- Ensure directory name starts with `mcp-`
- Check that the directory exists and has a CLAUDE.md

**Changes not being analyzed:**
- First run establishes baseline (new pages detected)
- Subsequent runs compare hashes to detect actual changes
