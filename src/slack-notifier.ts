import { IncomingWebhook } from '@slack/webhook';
import { type EngineerOutput } from './agents/engineer.js';

interface SlackBlock {
  type: string;
  text?: {
    type: string;
    text: string;
    emoji?: boolean;
  };
  elements?: Array<{
    type: string;
    text?: string;
    url?: string;
  }>;
}

/**
 * Send notification about detected changes to Slack
 */
export async function notifyChanges(
  webhookUrl: string,
  engineerOutput: EngineerOutput
): Promise<boolean> {
  // Only notify if there's an action to take
  if (engineerOutput.action === 'none') {
    console.log('No action needed. Skipping notification.');
    return false;
  }

  const webhook = new IncomingWebhook(webhookUrl);
  const blocks = buildSlackBlocks(engineerOutput);

  try {
    await webhook.send({
      text: `MCP Monitor: ${engineerOutput.summary}`,
      blocks,
    });
    return true;
  } catch (error) {
    console.error('Failed to send Slack notification:', error);
    return false;
  }
}

/**
 * Send a test notification to verify webhook configuration
 */
export async function sendTestNotification(webhookUrl: string): Promise<boolean> {
  const webhook = new IncomingWebhook(webhookUrl);

  try {
    await webhook.send({
      text: 'MCP Monitor Test',
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: 'MCP Monitor v2 - Test Notification',
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'This is a test notification from the MCP Upstream API Monitor v2 (LLM-powered). If you see this, your Slack webhook is configured correctly!',
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Sent at: ${new Date().toISOString()}`,
            },
          ],
        },
      ],
    });
    return true;
  } catch (error) {
    console.error('Failed to send test notification:', error);
    return false;
  }
}

function buildSlackBlocks(engineerOutput: EngineerOutput): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  // Header with urgency indicator
  const headerEmoji = engineerOutput.action === 'urgent' ? ':rotating_light:' : ':bell:';
  const headerText =
    engineerOutput.action === 'urgent'
      ? 'MCP Monitor - URGENT Action Required'
      : 'MCP Monitor - Changes Detected';

  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: headerText,
      emoji: true,
    },
  });

  // Summary section
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `${headerEmoji} *${engineerOutput.summary}*`,
    },
  });

  // Affected MCPs
  if (engineerOutput.affectedMcps.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Affected MCPs:* ${engineerOutput.affectedMcps.join(', ')}`,
      },
    });
  }

  blocks.push({ type: 'divider' } as SlackBlock);

  // Details for each affected MCP
  for (const detail of engineerOutput.details) {
    let impactEmoji: string;
    switch (detail.impact) {
      case 'high':
        impactEmoji = ':red_circle:';
        break;
      case 'medium':
        impactEmoji = ':large_yellow_circle:';
        break;
      default:
        impactEmoji = ':white_circle:';
    }

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${impactEmoji} *${detail.mcp}*\n${detail.changes.map((c) => `• ${c}`).join('\n')}`,
      },
    });
  }

  // Recommended action
  if (engineerOutput.recommendedAction !== 'No action needed') {
    blocks.push({ type: 'divider' } as SlackBlock);
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:clipboard: *Recommended Action:*\n${engineerOutput.recommendedAction}`,
      },
    });
  }

  // Footer
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Report generated at ${new Date().toISOString()} | MCP Monitor v2 (LLM-powered)`,
      },
    ],
  });

  return blocks;
}

/**
 * Format the engineer output as a console-friendly report
 */
export function formatConsoleReport(engineerOutput: EngineerOutput): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('              MCP UPSTREAM API MONITOR REPORT v2               ');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');

  // Action indicator
  let actionIndicator: string;
  switch (engineerOutput.action) {
    case 'urgent':
      actionIndicator = '[!!!] URGENT';
      break;
    case 'notify':
      actionIndicator = '[!] NOTIFY';
      break;
    default:
      actionIndicator = '[ ] NO ACTION';
  }

  lines.push(`Action: ${actionIndicator}`);
  lines.push('');
  lines.push(`Summary: ${engineerOutput.summary}`);
  lines.push('');

  if (engineerOutput.affectedMcps.length > 0) {
    lines.push(`Affected MCPs: ${engineerOutput.affectedMcps.join(', ')}`);
    lines.push('');
  }

  if (engineerOutput.details.length > 0) {
    lines.push('───────────────────────────────────────────────────────────────');
    lines.push('                          DETAILS                              ');
    lines.push('───────────────────────────────────────────────────────────────');

    for (const detail of engineerOutput.details) {
      let impactIcon: string;
      switch (detail.impact) {
        case 'high':
          impactIcon = '[!]';
          break;
        case 'medium':
          impactIcon = '[~]';
          break;
        default:
          impactIcon = '[ ]';
      }

      lines.push('');
      lines.push(`${impactIcon} ${detail.mcp} (${detail.impact} impact)`);
      for (const change of detail.changes) {
        lines.push(`    • ${change}`);
      }
    }
    lines.push('');
  }

  if (engineerOutput.recommendedAction !== 'No action needed') {
    lines.push('───────────────────────────────────────────────────────────────');
    lines.push(`Recommended Action: ${engineerOutput.recommendedAction}`);
  }

  lines.push('');
  lines.push(`Report generated: ${new Date().toISOString()}`);

  return lines.join('\n');
}
