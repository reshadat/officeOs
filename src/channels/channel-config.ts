/**
 * Channel config registry — the adapter-layer source of truth for "what does an
 * agent's .env need to talk on channel X, and is it valid".
 *
 * The CLI (enable, onboard) must NOT hardcode SLACK_* vs BOT_TOKEN. It asks this
 * registry: detect which channel an .env configures, list the required keys, and
 * validate the credentials through the channel's own adapter. Adding a new
 * channel = add one ChannelConfigSpec entry; no CLI change.
 */
import { resolveAdapter } from './registry.js';
import { TelegramAPI, formatValidateError } from '../telegram/api.js';

export type EnvMap = Record<string, string | undefined>;

export interface ChannelValidation {
  ok: boolean;
  /** Human-readable detail for logging (no secrets). */
  detail: string;
  /** When ok is false: should this hard-fail enable, or only warn? */
  blocking: boolean;
}

export interface ChannelConfigSpec {
  kind: string;
  /** Does this .env configure this channel? (signature key present) */
  detect(env: EnvMap): boolean;
  /** Env keys that must ALL be present for this channel to work. */
  requiredKeys: string[];
  /** Live credential check via the channel's own adapter. */
  validate(env: EnvMap): Promise<ChannelValidation>;
}

export const CHANNEL_SPECS: ChannelConfigSpec[] = [
  {
    kind: 'slack',
    detect: (e) => !!e.SLACK_BOT_TOKEN,
    requiredKeys: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_CHANNEL_ID'],
    async validate(e) {
      const adapter = resolveAdapter('slack', { botToken: e.SLACK_BOT_TOKEN });
      if (!adapter) return { ok: true, detail: 'no adapter (mock?) — skipped', blocking: false };
      const res = await adapter.validateCredentials();
      if (res.ok) return { ok: true, detail: `bot ${res.identity ?? 'ok'}, channel ${e.SLACK_CHANNEL_ID}`, blocking: false };
      // Warn-not-block: onboarding validated the token live, and a transient
      // Slack API hiccup shouldn't block enable.
      return { ok: false, detail: res.error ?? 'unknown', blocking: false };
    },
  },
  {
    kind: 'telegram',
    detect: (e) => !!(e.BOT_TOKEN || e.CHAT_ID),
    requiredKeys: ['BOT_TOKEN', 'CHAT_ID'],
    async validate(e) {
      const v = await new TelegramAPI(e.BOT_TOKEN!).validateCredentials(e.CHAT_ID!);
      if (v.ok) {
        const label = v.chatTitle ? ` (${v.chatTitle})` : '';
        return { ok: true, detail: `bot=@${v.botUsername} chat=${e.CHAT_ID} type=${v.chatType}${label}`, blocking: false };
      }
      // Block on config-level failures (bad_token, chat_not_found, self_chat);
      // warn-not-block on transient ones so offline/burst enable still works.
      const transient = v.reason === 'network_error' || v.reason === 'rate_limited';
      return { ok: false, detail: formatValidateError(v), blocking: !transient };
    },
  },
];

/** The channel an agent's .env is configured for, or null if none (bus-only). */
export function detectChannel(env: EnvMap): ChannelConfigSpec | null {
  return CHANNEL_SPECS.find((s) => s.detect(env)) ?? null;
}

/** Human list of every channel's required keys, for error messages. */
export function channelConfigHint(): string {
  return CHANNEL_SPECS.map((s) => `${s.kind} (${s.requiredKeys.join(', ')})`).join(' or ');
}
