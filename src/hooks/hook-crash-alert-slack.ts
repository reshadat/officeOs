import { join } from 'path';
import { existsSync, readFileSync, statSync } from 'fs';

function classifyEnd(stateDir: string): { emoji: string; label: string } {
  const nowMs = Date.now();
  const MARKER_WINDOW_MS = 60 * 1000;

  const markerRecent = (name: string) => {
    const p = join(stateDir, name);
    if (!existsSync(p)) return false;
    try { return (nowMs - statSync(p).mtimeMs) < MARKER_WINDOW_MS; } catch { return false; }
  };

  if (markerRecent('planned-restart.marker')) return { emoji: '🔄', label: 'planned restart' };
  if (markerRecent('session-refresh.marker')) return { emoji: '♻️', label: 'session refresh' };
  if (markerRecent('rate-limited.marker')) return { emoji: '⏳', label: 'rate limited' };
  if (markerRecent('max-turns.marker')) return { emoji: '🔁', label: 'max turns reached' };
  return { emoji: '🚨', label: 'CRASH' };
}

async function main(): Promise<void> {
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

  if (!botToken || !channelId) return;

  let threadTs: string | undefined;
  try {
    const threadState = JSON.parse(readFileSync(join(stateDir, 'slack-thread.json'), 'utf-8'));
    if (threadState.channel === channelId && threadState.threadTs) threadTs = threadState.threadTs;
  } catch { /* no active thread */ }

  const { emoji, label } = classifyEnd(stateDir);
  const message = `${emoji} *${agentName}* session ended: ${label}`;
  const payload: Record<string, unknown> = { channel: channelId, text: message };
  if (threadTs) payload.thread_ts = threadTs;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // Non-fatal
  } finally {
    clearTimeout(timer);
  }
}

main().catch(() => process.exit(0));
