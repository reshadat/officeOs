import { join } from 'path';
import { existsSync, readFileSync } from 'fs';

async function main(): Promise<void> {
  const agentName = process.env.CTX_AGENT_NAME || 'agent';
  const agentDir = process.env.CTX_AGENT_DIR || '';

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

  if (!botToken || !channelId) return;

  const ctxRoot = process.env.CTX_ROOT || join(require('os').homedir(), '.officeos', 'default');
  const stateDir = join(ctxRoot, 'state', agentName);
  let threadTs: string | undefined;
  try {
    const threadState = JSON.parse(readFileSync(join(stateDir, 'slack-thread.json'), 'utf-8'));
    if (threadState.channel === channelId && threadState.threadTs) threadTs = threadState.threadTs;
  } catch { /* no active thread */ }

  const message = `[Context] *${agentName}* is compacting context (context window near limit).`;
  const payload: Record<string, unknown> = { channel: channelId, text: message };
  if (threadTs) payload.thread_ts = threadTs;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // Non-fatal, non-blocking
  } finally {
    clearTimeout(timer);
  }
}

main().catch(() => process.exit(0));
