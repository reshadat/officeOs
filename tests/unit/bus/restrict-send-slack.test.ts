import { describe, it, expect } from 'vitest';

function isChannelAllowed(channelId: string, originChannel: string | undefined, outboundAllowlist: string[]): boolean {
  if (!originChannel && outboundAllowlist.length === 0) return true;
  const allowed = outboundAllowlist.length > 0 ? outboundAllowlist : (originChannel ? [originChannel] : []);
  return allowed.includes(channelId);
}

describe('send-slack channel restriction', () => {
  it('allows posting to origin channel', () => {
    expect(isChannelAllowed('C123', 'C123', [])).toBe(true);
  });

  it('blocks posting to different channel when origin is set', () => {
    expect(isChannelAllowed('C_OTHER', 'C123', [])).toBe(false);
  });

  it('allows posting to channel in SLACK_OUTBOUND_CHANNELS even if not origin', () => {
    expect(isChannelAllowed('C_OTHER', 'C123', ['C_OTHER', 'C_THIRD'])).toBe(true);
  });

  it('allows any channel when no origin and no allowlist', () => {
    expect(isChannelAllowed('C_ANYTHING', undefined, [])).toBe(true);
  });

  it('blocks origin channel when allowlist overrides it', () => {
    expect(isChannelAllowed('C123', 'C123', ['C_ALLOWED_ONLY'])).toBe(false);
  });

  it('allows any of multiple allowlisted channels', () => {
    expect(isChannelAllowed('C_THIRD', undefined, ['C_ONE', 'C_TWO', 'C_THIRD'])).toBe(true);
  });
});
