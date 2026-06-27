/**
 * Adapter registry — the single place that maps a channel kind to a concrete
 * ChannelAdapter. Adding Teams/WhatsApp later means one new case here.
 *
 * Test seam: OFFICEOS_CHANNEL_ADAPTER=mock forces the MockAdapter for any kind,
 * so a spawned `officeos onboard` runs with zero network.
 */
import type { AdapterContext, ChannelAdapter } from './adapter.js';
import { SlackAdapter } from './slack/slack-adapter.js';
import { MockAdapter } from './mock/mock-adapter.js';

export type ChannelKind = 'slack' | 'mock';

/** Channels with a concrete adapter today. Telegram is accommodated but not yet built. */
export const SUPPORTED_CHANNELS: ChannelKind[] = ['slack', 'mock'];

export function resolveAdapter(kind: string, ctx: AdapterContext = {}): ChannelAdapter {
  // Global test override — wins over the requested kind.
  if (process.env.OFFICEOS_CHANNEL_ADAPTER === 'mock') {
    return new MockAdapter();
  }

  switch (kind) {
    case 'mock':
      return new MockAdapter();
    case 'slack': {
      const botToken =
        ctx.botToken ?? ctx.env?.SLACK_BOT_TOKEN ?? process.env.SLACK_BOT_TOKEN;
      if (!botToken) {
        throw new Error('resolveAdapter(slack): no bot token (ctx.botToken / SLACK_BOT_TOKEN)');
      }
      return new SlackAdapter(botToken);
    }
    case 'telegram':
      throw new Error(
        'resolveAdapter(telegram): Telegram is not adapter-ized yet — it runs on its existing path',
      );
    default:
      throw new Error(`resolveAdapter: unknown channel kind "${kind}"`);
  }
}
