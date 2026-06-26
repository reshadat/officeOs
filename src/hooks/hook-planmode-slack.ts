import { join } from 'path';
import { existsSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import {
  readStdin, outputDecision, generateId, waitForResponseFile, cleanupResponseFile,
} from './index.js';

function findMostRecentPlan(stateDir: string): string | null {
  try {
    const files = readdirSync(stateDir).filter((f) => f.endsWith('-plan.md'));
    if (!files.length) return null;
    files.sort();
    return readFileSync(join(stateDir, files[files.length - 1]), 'utf-8');
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  await readStdin();

  const agentName = process.env.CTX_AGENT_NAME || 'agent';
  const ctxRoot = process.env.CTX_ROOT || join(require('os').homedir(), '.officeos', 'default');
  const agentDir = process.env.CTX_AGENT_DIR || '';
  const stateDir = join(ctxRoot, 'state', agentName);

  let botToken = '';
  let channelId = '';
  const envFile = join(agentDir, '.env');
  if (existsSync(envFile)) {
    const content = readFileSync(envFile, 'utf-8');
    botToken = content.match(/^SLACK_BOT_TOKEN=(.+)$/m)?.[1]?.trim() || '';
    channelId = content.match(/^SLACK_CHANNEL_ID=(.+)$/m)?.[1]?.trim() || '';
  }
  if (!botToken) botToken = process.env.SLACK_BOT_TOKEN || '';
  if (!channelId) channelId = process.env.SLACK_CHANNEL_ID || '';

  if (!botToken || !channelId) {
    outputDecision('allow', 'No Slack credentials — auto-approving plan');
    return;
  }

  const plan = findMostRecentPlan(stateDir);
  const planPreview = plan ? plan.slice(0, 800) : '(no plan file found)';

  const uniqueId = generateId();
  const responseFile = join(stateDir, `hook-response-${uniqueId}.json`);
  const pendingFile = join(stateDir, `hook-response-${uniqueId}.pending`);

  const cleanup = () => {
    cleanupResponseFile(responseFile);
    cleanupResponseFile(pendingFile);
  };
  process.on('exit', cleanup);
  process.on('SIGTERM', () => { cleanup(); outputDecision('deny', 'Hook terminated (SIGTERM)'); });
  process.on('SIGINT',  () => { cleanup(); outputDecision('deny', 'Hook terminated (SIGINT)'); });

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(pendingFile, JSON.stringify({ uniqueId, agentName, type: 'plan', channelId }), 'utf-8');

  const truncated = plan && plan.length > 800 ? '\n…(truncated)' : '';
  const message = `[Plan] *${agentName}* has a plan:\n\`\`\`\n${planPreview}${truncated}\n\`\`\`\nReply \`allow\` to approve or \`deny\` to reject (30 min timeout → auto-approve)`;

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
    // Non-fatal
  } finally {
    clearTimeout(sendTimer);
  }

  const content = await waitForResponseFile(responseFile, 30 * 60 * 1000);
  cleanup();

  if (!content) {
    outputDecision('allow', 'Plan auto-approved (30 min timeout)');
    return;
  }

  try {
    const parsed = JSON.parse(content);
    const decision = parsed.decision === 'deny' ? 'deny' : 'allow';
    outputDecision(decision);
  } catch {
    outputDecision('allow', 'Invalid response — auto-approving plan');
  }
}

main().catch((err) => {
  // Crash → deny. Timeout → allow (separate path above). Don't silently approve on error.
  outputDecision('deny', `Hook crashed: ${err?.message ?? 'unknown error'}`);
});
