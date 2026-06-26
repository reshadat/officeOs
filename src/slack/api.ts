import { WebClient } from '@slack/web-api';

const MAX_MESSAGE_LENGTH = 3000;

function splitText(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, MAX_MESSAGE_LENGTH));
    remaining = remaining.slice(MAX_MESSAGE_LENGTH);
  }
  return chunks;
}

export class SlackAPI {
  private client: WebClient;
  private botUserIdCache: string | null = null;

  constructor(botToken: string) {
    this.client = new WebClient(botToken);
  }

  async sendMessage(channelId: string, text: string): Promise<{ ts: string; channel: string } | null> {
    const chunks = splitText(text);
    let result: { ts: string; channel: string } | null = null;
    for (const chunk of chunks) {
      const res = await this.client.chat.postMessage({
        channel: channelId,
        text: chunk,
        mrkdwn: true,
      });
      if (!result && res.ts && res.channel) {
        result = { ts: res.ts, channel: res.channel };
      }
    }
    return result;
  }

  async updateMessage(channelId: string, ts: string, text: string): Promise<void> {
    await this.client.chat.update({ channel: channelId, ts, text });
  }

  // Returns the bot's own Slack user ID. Cached after first call.
  async getBotUserId(): Promise<string | null> {
    if (this.botUserIdCache) return this.botUserIdCache;
    try {
      const res = await this.client.auth.test();
      this.botUserIdCache = (res.user_id as string) || null;
      return this.botUserIdCache;
    } catch {
      return null;
    }
  }

  // Leave a channel. Silently succeeds if already not a member.
  async leaveChannel(channelId: string): Promise<void> {
    try {
      await this.client.conversations.leave({ channel: channelId });
    } catch { /* not a member, or DM — both fine */ }
  }

  // Open a DM with userId and send text.
  async dmUser(userId: string, text: string): Promise<void> {
    try {
      const res = await this.client.conversations.open({ users: userId });
      const dmChannelId = (res.channel as any)?.id;
      if (dmChannelId) await this.sendMessage(dmChannelId, text);
    } catch { /* user unreachable */ }
  }
}
