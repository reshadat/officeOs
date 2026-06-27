import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveAdapter } from '../../../src/channels/registry.js';
import { MockAdapter } from '../../../src/channels/mock/mock-adapter.js';
import { SlackAdapter } from '../../../src/channels/slack/slack-adapter.js';

describe('resolveAdapter', () => {
  let savedOverride: string | undefined;
  let savedBotToken: string | undefined;

  beforeEach(() => {
    savedOverride = process.env.OFFICEOS_CHANNEL_ADAPTER;
    savedBotToken = process.env.SLACK_BOT_TOKEN;
    delete process.env.OFFICEOS_CHANNEL_ADAPTER;
    delete process.env.SLACK_BOT_TOKEN;
  });

  afterEach(() => {
    if (savedOverride === undefined) delete process.env.OFFICEOS_CHANNEL_ADAPTER;
    else process.env.OFFICEOS_CHANNEL_ADAPTER = savedOverride;
    if (savedBotToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = savedBotToken;
  });

  it('returns MockAdapter for kind "mock"', () => {
    expect(resolveAdapter('mock')).toBeInstanceOf(MockAdapter);
  });

  it('OFFICEOS_CHANNEL_ADAPTER=mock forces mock even when slack is requested', () => {
    process.env.OFFICEOS_CHANNEL_ADAPTER = 'mock';
    const a = resolveAdapter('slack', { botToken: 'xoxb-real' });
    expect(a).toBeInstanceOf(MockAdapter);
    expect(a.kind).toBe('mock');
  });

  it('returns SlackAdapter for kind "slack" with an explicit token', () => {
    const a = resolveAdapter('slack', { botToken: 'xoxb-abc' });
    expect(a).toBeInstanceOf(SlackAdapter);
    expect(a.kind).toBe('slack');
  });

  it('reads SLACK_BOT_TOKEN from env when ctx token absent', () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-from-env';
    expect(resolveAdapter('slack')).toBeInstanceOf(SlackAdapter);
  });

  it('throws for slack with no token anywhere', () => {
    expect(() => resolveAdapter('slack')).toThrow(/no bot token/);
  });

  it('throws a clear message for telegram (not yet adapter-ized)', () => {
    expect(() => resolveAdapter('telegram')).toThrow(/not adapter-ized/);
  });

  it('throws for an unknown kind', () => {
    expect(() => resolveAdapter('signal')).toThrow(/unknown channel kind/);
  });
});
