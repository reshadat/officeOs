import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getTarget, activeConversations } from '../../../src/channels/reply-targets.js';

// Capture both handlers SlackAdapter registers on the socket so the test can
// fire message AND member_joined_channel events through the real gate logic.
let messageHandler: ((event: any) => Promise<void> | void) | undefined;
let eventHandlers: Record<string, (ev: any) => Promise<void> | void> = {};
vi.mock('../../../src/slack/socket-client.js', () => ({
  SlackSocketClient: class {
    constructor(_t: string) {}
    onMessage(h: any) { messageHandler = h; }
    onEvent(t: string, h: any) { eventHandlers[t] = h; }
    start() { return Promise.resolve(); }
    stop() { return Promise.resolve(); }
  },
}));

// Controllable SlackAPI — no network.
const getBotUserId = vi.fn(async () => 'UBOT');
const getThreadReplies = vi.fn(async () => [] as any[]);
const leaveChannel = vi.fn(async () => {});
const dmUser = vi.fn(async () => {});
vi.mock('../../../src/slack/api.js', () => ({
  SlackAPI: class {
    constructor(_t: string) {}
    getBotUserId = getBotUserId;
    getThreadReplies = getThreadReplies;
    leaveChannel = leaveChannel;
    dmUser = dmUser;
  },
}));

import { SlackAdapter, type SlackInboundConfig } from '../../../src/channels/slack/slack-adapter.js';

function makeConfig(over: Partial<SlackInboundConfig>, stateDir: string): SlackInboundConfig {
  return {
    appToken: 'xapp-1',
    ownerId: 'UOWNER',
    allowedChannels: new Set(['CALLOWED']),
    readonlyIds: new Set<string>(),
    allowedDomains: new Set<string>(),
    rateLimitSpec: '10/60',
    stateDir,
    ...over,
  };
}

interface Captured { messages: any[]; approvals: any[] }
function handlers(): { h: any; c: Captured } {
  const c: Captured = { messages: [], approvals: [] };
  return {
    c,
    h: {
      onMessage: (m: any) => { c.messages.push(m); },
      onApproval: (decision: string, shortId: string | undefined, role: string) => { c.approvals.push({ decision, shortId, role }); },
    },
  };
}

// Default to a DM (1:1, always engaged) so the core-processing tests aren't
// subject to the channel "@-mention to engage" gate. Channel-gate tests pass
// channel_type:'channel' explicitly.
async function fire(event: Partial<any>) {
  await messageHandler!({ type: 'message', channel: 'D1', channel_type: 'im', ts: '1700.1', ...event });
}
/** Fire a CHANNEL message (engagement gate applies). */
async function fireChannel(event: Partial<any>) {
  await messageHandler!({ type: 'message', channel: 'CALLOWED', channel_type: 'channel', ts: '1700.1', ...event });
}

describe('SlackAdapter inbound gates', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slack-inbound-'));
    messageHandler = undefined;
    eventHandlers = {};
    getBotUserId.mockClear();
    getThreadReplies.mockClear().mockResolvedValue([]);
    leaveChannel.mockClear();
    dmUser.mockClear();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('owner message is injected with OWNER tag', async () => {
    const { h, c } = handlers();
    await new SlackAdapter('xoxb', makeConfig({}, dir)).start(h);
    await fire({ user: 'UOWNER', text: 'what shipped overnight?' });
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0].senderRole).toBe('owner');
    expect(c.messages[0].injection).toContain('[OWNER]');
    expect(c.messages[0].injection).toContain('what shipped overnight?');
  });

  it('drops unknown users (gate 1)', async () => {
    const { h, c } = handlers();
    await new SlackAdapter('xoxb', makeConfig({}, dir)).start(h);
    await fire({ user: 'USTRANGER', text: 'hi' });
    expect(c.messages).toHaveLength(0);
  });

  it('drops non-DM messages outside the channel allowlist (gate 2)', async () => {
    const { h, c } = handlers();
    await new SlackAdapter('xoxb', makeConfig({}, dir)).start(h);
    await fireChannel({ user: 'UOWNER', text: 'hi', channel: 'COTHER' });
    expect(c.messages).toHaveLength(0);
  });

  it('accepts an owner DM even when no channel is configured (gate 2)', async () => {
    const { h, c } = handlers();
    await new SlackAdapter('xoxb', makeConfig({ allowedChannels: new Set() }, dir)).start(h);
    await fire({ user: 'UOWNER', text: 'hi', channel: 'D1', channel_type: 'im' });
    expect(c.messages).toHaveLength(1);
  });

  it('DM-only (no channels configured) rejects a non-DM message — no fail-open (gate 2)', async () => {
    const { h, c } = handlers();
    await new SlackAdapter('xoxb', makeConfig({ allowedChannels: new Set() }, dir)).start(h);
    await fire({ user: 'UOWNER', text: 'hi', channel: 'CRANDOM', channel_type: 'channel' });
    expect(c.messages).toHaveLength(0);
  });

  it('accepts a readonly DM (gate 2)', async () => {
    const { h, c } = handlers();
    await new SlackAdapter('xoxb', makeConfig({ readonlyIds: new Set(['URO']) }, dir)).start(h);
    await fire({ user: 'URO', text: 'status?', channel: 'D2', channel_type: 'im' });
    expect(c.messages).toHaveLength(1);
  });

  it('owner approval routes allow + deny with shortId, not onMessage (gate 5)', async () => {
    const { h, c } = handlers();
    await new SlackAdapter('xoxb', makeConfig({}, dir)).start(h);
    await fire({ user: 'UOWNER', text: 'allow a1b2c3' });
    await fire({ user: 'UOWNER', text: 'deny f00d' });
    expect(c.messages).toHaveLength(0);
    expect(c.approvals).toEqual([
      { decision: 'allow', shortId: 'a1b2c3', role: 'owner' },
      { decision: 'deny', shortId: 'f00d', role: 'owner' },
    ]);
  });

  it('bare allow (no id) routes with undefined shortId', async () => {
    const { h, c } = handlers();
    await new SlackAdapter('xoxb', makeConfig({}, dir)).start(h);
    await fire({ user: 'UOWNER', text: 'allow' });
    expect(c.approvals).toEqual([{ decision: 'allow', shortId: undefined, role: 'owner' }]);
  });

  it('readonly attempting approval is blocked (no inject, no approval)', async () => {
    const { h, c } = handlers();
    await new SlackAdapter('xoxb', makeConfig({ readonlyIds: new Set(['URO']) }, dir)).start(h);
    await fire({ user: 'URO', text: 'allow a1b2c3' });
    expect(c.messages).toHaveLength(0);
    expect(c.approvals).toHaveLength(0);
  });

  it('readonly message carries the READONLY preamble', async () => {
    const { h, c } = handlers();
    await new SlackAdapter('xoxb', makeConfig({ readonlyIds: new Set(['URO']) }, dir)).start(h);
    await fire({ user: 'URO', text: 'status?' });
    expect(c.messages[0].senderRole).toBe('readonly');
    expect(c.messages[0].injection).toContain('READONLY USER');
  });

  it('rate-limits readonly users (gate 4)', async () => {
    const { h, c } = handlers();
    await new SlackAdapter('xoxb', makeConfig({ readonlyIds: new Set(['URO']), rateLimitSpec: '1/60' }, dir)).start(h);
    await fire({ user: 'URO', text: 'one' });
    await fire({ user: 'URO', text: 'two' });
    expect(c.messages).toHaveLength(1);
  });

  it('enforces the email domain allowlist and caches the lookup (gate 3)', async () => {
    const fetchMock = vi.fn(async (url: any) => {
      const isEvil = String(url).includes('UEVIL');
      return { json: async () => ({ user: { profile: { email: isEvil ? 'x@evil.com' : 'x@acme.com' } } }) } as any;
    });
    vi.stubGlobal('fetch', fetchMock);
    const { h, c } = handlers();
    await new SlackAdapter('xoxb', makeConfig({
      readonlyIds: new Set(['UEVIL', 'UGOOD']),
      allowedDomains: new Set(['acme.com']),
    }, dir)).start(h);
    await fire({ user: 'UEVIL', text: 'hi' });
    await fire({ user: 'UGOOD', text: 'hi' });
    await fire({ user: 'UGOOD', text: 'again' }); // second from same user must hit cache
    expect(c.messages.map((m) => m.senderId)).toEqual(['UGOOD', 'UGOOD']);
    expect(fetchMock).toHaveBeenCalledTimes(2); // one per distinct user, not per message
  });

  it('denies (and caches) when the domain lookup throws (gate 3)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const { h, c } = handlers();
    await new SlackAdapter('xoxb', makeConfig({
      readonlyIds: new Set(['URO']), allowedDomains: new Set(['acme.com']),
    }, dir)).start(h);
    await fire({ user: 'URO', text: 'hi' });
    expect(c.messages).toHaveLength(0);
  });

  it('injects thread context for a reply in an existing thread', async () => {
    getThreadReplies.mockResolvedValue([
      { user: 'UOWNER', text: 'first question', ts: '1699.0' },
      { bot_id: 'B1', text: 'agent answer', ts: '1699.5' },
      { user: 'UOWNER', text: 'follow up', ts: '1700.2' },
    ]);
    const { h, c } = handlers();
    await new SlackAdapter('xoxb', makeConfig({}, dir)).start(h);
    await fire({ user: 'UOWNER', text: 'follow up', ts: '1700.2', thread_ts: '1699.0' });
    expect(getThreadReplies).toHaveBeenCalledWith('D1', '1699.0');
    const inj = c.messages[0].injection;
    expect(inj).toContain('[Thread context]');
    expect(inj).toContain('first question');
    expect(inj).toContain('Agent: agent answer'); // bot_id → Agent label
    expect(inj).not.toMatch(/Thread context][\s\S]*follow up[\s\S]*\[End thread/); // current msg excluded from context
  });

  it('records a per-request reply target for hook/agent reply routing', async () => {
    const { h, c } = handlers();
    await new SlackAdapter('xoxb', makeConfig({}, dir)).start(h);
    await fire({ user: 'UOWNER', text: 'hi', channel: 'CALLOWED', ts: '1700.9', thread_ts: '1700.3' });
    // The adapter minted a request_id (also on the emitted message) and stored its target.
    const reqId = c.messages[0].requestId;
    expect(reqId).toBeTruthy();
    expect(getTarget(dir, reqId)).toMatchObject({ conversationId: 'CALLOWED', threadId: '1700.3' });
    expect([...activeConversations(dir)]).toEqual(['CALLOWED']);
  });
});

describe('SlackAdapter auto-eject (member_joined_channel)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slack-eject-'));
    messageHandler = undefined; eventHandlers = {};
    getBotUserId.mockClear().mockResolvedValue('UBOT');
    leaveChannel.mockClear(); dmUser.mockClear();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('ejects + DMs the owner when a non-owner invites the bot', async () => {
    const { h } = handlers();
    await new SlackAdapter('xoxb', makeConfig({}, dir)).start(h);
    await eventHandlers['member_joined_channel']!({ user: 'UBOT', inviter: 'USTRANGER', channel: 'CNEW' });
    expect(leaveChannel).toHaveBeenCalledWith('CNEW');
    expect(dmUser).toHaveBeenCalledWith('UOWNER', expect.stringContaining('CNEW'));
  });

  it('adds the channel to the allowlist when the owner invites the bot', async () => {
    const { h, c } = handlers();
    const cfg = makeConfig({ allowedChannels: new Set() }, dir);
    await new SlackAdapter('xoxb', cfg).start(h);
    await eventHandlers['member_joined_channel']!({ user: 'UBOT', inviter: 'UOWNER', channel: 'CNEW' });
    expect(leaveChannel).not.toHaveBeenCalled();
    // proof: an @-mention in the newly-allowed channel now passes gate 2 + engagement
    await fireChannel({ user: 'UOWNER', text: '<@UBOT> hi', channel: 'CNEW' });
    expect(c.messages).toHaveLength(1);
  });

  it('ignores joins by users other than the bot', async () => {
    const { h } = handlers();
    await new SlackAdapter('xoxb', makeConfig({}, dir)).start(h);
    await eventHandlers['member_joined_channel']!({ user: 'USOMEONE', inviter: 'USTRANGER', channel: 'CNEW' });
    expect(leaveChannel).not.toHaveBeenCalled();
  });

  // ── Engagement: channel = speak when addressed; DM = always; thread = sticky ──
  describe('channel engagement gate', () => {
    it('ignores a channel message that does not @-mention the bot', async () => {
      const { h, c } = handlers();
      await new SlackAdapter('xoxb', makeConfig({}, dir)).start(h);
      await fireChannel({ user: 'UOWNER', text: 'random chatter, not for the bot' });
      expect(c.messages).toHaveLength(0);
    });

    it('engages when @-mentioned in a channel', async () => {
      const { h, c } = handlers();
      await new SlackAdapter('xoxb', makeConfig({}, dir)).start(h);
      await fireChannel({ user: 'UOWNER', text: '<@UBOT> hello', ts: '1700.1' });
      expect(c.messages).toHaveLength(1);
    });

    it('stays engaged for every message in a thread it is already in (no re-mention)', async () => {
      const { h, c } = handlers();
      await new SlackAdapter('xoxb', makeConfig({}, dir)).start(h);
      await fireChannel({ user: 'UOWNER', text: '<@UBOT> start', ts: '1700.1' });
      await fireChannel({ user: 'UOWNER', text: 'follow up, no mention', ts: '1700.2', thread_ts: '1700.1' });
      expect(c.messages).toHaveLength(2);
    });

    it('disengages a thread on "stop" and ignores later messages until re-mentioned', async () => {
      const { h, c } = handlers();
      await new SlackAdapter('xoxb', makeConfig({}, dir)).start(h);
      await fireChannel({ user: 'UOWNER', text: '<@UBOT> start', ts: '1700.1' });
      await fireChannel({ user: 'UOWNER', text: 'stop', ts: '1700.2', thread_ts: '1700.1' });
      await fireChannel({ user: 'UOWNER', text: 'are you there?', ts: '1700.3', thread_ts: '1700.1' });
      expect(c.messages).toHaveLength(1); // only the opening mention was processed
    });

    it('a DM is always engaged — no mention needed', async () => {
      const { h, c } = handlers();
      await new SlackAdapter('xoxb', makeConfig({}, dir)).start(h);
      await fire({ user: 'UOWNER', text: 'just chatting, like a colleague' });
      expect(c.messages).toHaveLength(1);
    });
  });
});
