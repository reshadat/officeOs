import { join } from 'path';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import {
  readStdin, parseHookInput, outputDecision, generateId,
  waitForResponseFile, formatToolSummary, isClaudeDirOperation, cleanupResponseFile,
} from './index.js';

async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_name, tool_input } = parseHookInput(input);

  const agentName = process.env.CTX_AGENT_NAME || 'agent';
  const ctxRoot = process.env.CTX_ROOT || join(require('os').homedir(), '.officeos', 'default');
  const agentDir = process.env.CTX_AGENT_DIR || '';
  const stateDir = join(ctxRoot, 'state', agentName);

  let botToken = '';
  let channelId = '';
  const envFile = join(agentDir, '.env');
  if (existsSync(envFile)) {
    const content = require('fs').readFileSync(envFile, 'utf-8');
    botToken = content.match(/^SLACK_BOT_TOKEN=(.+)$/m)?.[1]?.trim() || '';
    channelId = content.match(/^SLACK_CHANNEL_ID=(.+)$/m)?.[1]?.trim() || '';
  }
  if (!botToken) botToken = process.env.SLACK_BOT_TOKEN || '';
  if (!channelId) channelId = process.env.SLACK_CHANNEL_ID || '';

  if (!botToken || !channelId) {
    outputDecision('deny', 'Slack credentials not configured');
    return;
  }

  if (agentDir && isClaudeDirOperation(tool_name, tool_input, agentDir)) {
    outputDecision('allow');
    return;
  }

  const summary = formatToolSummary(tool_name, tool_input);
  const uniqueId = generateId();
  const responseFile = join(stateDir, `hook-response-${uniqueId}.json`);
  const pendingFile = join(stateDir, `hook-response-${uniqueId}.pending`);

  const cleanup = () => {
    cleanupResponseFile(responseFile);
    cleanupResponseFile(pendingFile);
  };
  process.on('exit', cleanup);
  // On signal: deny and exit — never allow on unexpected termination.
  process.on('SIGTERM', () => { cleanup(); outputDecision('deny', 'Hook terminated (SIGTERM)'); });
  process.on('SIGINT',  () => { cleanup(); outputDecision('deny', 'Hook terminated (SIGINT)'); });

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(pendingFile, JSON.stringify({ uniqueId, agentName, tool_name, channelId }), 'utf-8');

  const message = `[Permission] *${agentName}* wants to run \`${tool_name}\`\n${summary.slice(0, 1500)}\nReply \`allow\` or \`deny\` (30 min timeout → deny)`;

  const body = JSON.stringify({ channel: channelId, text: message, mrkdwn: true });
  const controller = new AbortController();
  const sendTimer = setTimeout(() => controller.abort(), 10000);
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${botToken}`, 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
  } catch {
    // Non-fatal — continue waiting for response file
  } finally {
    clearTimeout(sendTimer);
  }

  const content = await waitForResponseFile(responseFile, 30 * 60 * 1000);
  cleanup();

  if (!content) {
    outputDecision('deny', 'Approval timeout (30 min) — denied');
    return;
  }

  try {
    const parsed = JSON.parse(content);
    const decision = parsed.decision === 'allow' ? 'allow' : 'deny';
    outputDecision(decision, decision === 'deny' ? 'Denied via Slack' : undefined);
  } catch {
    outputDecision('deny', 'Invalid response format');
  }
}

main().catch((err) => {
  // Always deny on crash — never let an unhandled error silently allow a tool call.
  console.error('hook-permission-slack error:', err);
  outputDecision('deny', `Hook crashed: ${err?.message ?? 'unknown error'}`);
});
