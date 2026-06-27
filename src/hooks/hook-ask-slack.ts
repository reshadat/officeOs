import { join } from 'path';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { readStdin, parseHookInput, buildAskState, formatQuestionMessage } from './index.js';

async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_input } = parseHookInput(input);

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

  const questions = tool_input?.questions || [];
  if (questions.length === 0) return;

  mkdirSync(stateDir, { recursive: true });
  const askState = buildAskState(questions);
  writeFileSync(join(stateDir, 'ask-state.json'), JSON.stringify(askState, null, 2), 'utf-8');

  if (!botToken || !channelId) return;

  const q = questions[0];
  const header = formatQuestionMessage(agentName, 0, questions.length, q);
  const options = (q.options || []).map((o: any, i: number) => `${i + 1}. ${o.label || o}`).join('\n');
  const fullMsg = `${header}\n${options}\n\nReply with option number or text.`;

  let threadTs: string | undefined;
  try {
    const threadState = JSON.parse(require('fs').readFileSync(join(stateDir, 'slack-thread.json'), 'utf-8'));
    if (threadState.channel === channelId && threadState.threadTs) threadTs = threadState.threadTs;
  } catch { /* no active thread */ }

  const payload: Record<string, unknown> = { channel: channelId, text: fullMsg, mrkdwn: true };
  if (threadTs) payload.thread_ts = threadTs;
  const body = JSON.stringify(payload);
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${botToken}`, 'Content-Type': 'application/json' },
      body,
    });
  } catch {
    // Non-fatal — non-blocking hook
  }
}

main().catch(() => process.exit(0));
