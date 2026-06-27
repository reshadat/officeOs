import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── SlackAPI tests ────────────────────────────────────────────────────────────

const postMessageMock = vi.fn();
const repliesMock     = vi.fn();
const reactionsAddMock = vi.fn();

vi.mock('@slack/web-api', () => {
  const WebClient = vi.fn(function (this: any) {
    this.chat = { postMessage: postMessageMock };
    this.conversations = { replies: repliesMock, leave: vi.fn(), open: vi.fn() };
    this.reactions = { add: reactionsAddMock };
    this.auth = { test: vi.fn().mockResolvedValue({ user_id: 'U_BOT' }) };
  });
  return { WebClient };
});

import { SlackAPI } from '../../../src/slack/api.js';

describe('SlackAPI.sendMessage', () => {
  beforeEach(() => {
    postMessageMock.mockReset();
    postMessageMock.mockResolvedValue({ ok: true, ts: '1234567890.000001', channel: 'C123' });
  });

  it('sends without thread_ts for top-level message', async () => {
    const api = new SlackAPI('xoxb-token');
    await api.sendMessage('C123', 'hello');
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C123', text: 'hello' }),
    );
    expect(postMessageMock.mock.calls[0][0]).not.toHaveProperty('thread_ts');
  });

  it('passes thread_ts when provided', async () => {
    const api = new SlackAPI('xoxb-token');
    await api.sendMessage('C123', 'reply', '1111111111.000001');
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: '1111111111.000001' }),
    );
  });

  it('returns ts and channel from first chunk', async () => {
    const api = new SlackAPI('xoxb-token');
    const result = await api.sendMessage('C123', 'hi');
    expect(result).toEqual({ ts: '1234567890.000001', channel: 'C123' });
  });

  it('splits long messages into chunks', async () => {
    const api = new SlackAPI('xoxb-token');
    const long = 'x'.repeat(6001);
    await api.sendMessage('C123', long);
    expect(postMessageMock).toHaveBeenCalledTimes(3);
  });
});

describe('SlackAPI.getThreadReplies', () => {
  beforeEach(() => repliesMock.mockReset());

  it('returns messages array on success', async () => {
    repliesMock.mockResolvedValue({
      ok: true,
      messages: [
        { user: 'U1', text: 'first', ts: '1.1' },
        { user: 'U2', text: 'reply', ts: '1.2', bot_id: 'B1' },
      ],
    });
    const api = new SlackAPI('xoxb-token');
    const msgs = await api.getThreadReplies('C123', '1.1');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ user: 'U1', text: 'first', ts: '1.1', bot_id: undefined });
    expect(msgs[1]).toMatchObject({ bot_id: 'B1', text: 'reply' });
  });

  it('returns empty array when API returns no messages field', async () => {
    repliesMock.mockResolvedValue({ ok: false });
    const api = new SlackAPI('xoxb-token');
    const msgs = await api.getThreadReplies('C123', '1.1');
    expect(msgs).toEqual([]);
  });
});

describe('SlackAPI.addReaction', () => {
  beforeEach(() => reactionsAddMock.mockReset());

  it('calls reactions.add with correct params', async () => {
    reactionsAddMock.mockResolvedValue({ ok: true });
    const api = new SlackAPI('xoxb-token');
    await api.addReaction('C123', '1234567890.000001', 'eyes');
    expect(reactionsAddMock).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: '1234567890.000001',
      name: 'eyes',
    });
  });

  it('resolves successfully on happy path', async () => {
    reactionsAddMock.mockResolvedValue({ ok: true });
    const api = new SlackAPI('xoxb-token');
    await expect(api.addReaction('C123', '1.1', 'white_check_mark')).resolves.toBeUndefined();
    expect(reactionsAddMock).toHaveBeenCalledWith({
      channel: 'C123', timestamp: '1.1', name: 'white_check_mark',
    });
  });
});

// ── Approval regex tests ──────────────────────────────────────────────────────

describe('approval regex matching', () => {
  const ALLOW_RE = /^allow(?:\s+([a-f0-9]+))?$/i;
  const DENY_RE  = /^deny(?:\s+([a-f0-9]+))?$/i;

  it('bare allow matches', () => expect(ALLOW_RE.test('allow')).toBe(true));
  it('allow with id matches', () => {
    const m = 'allow a1b2c3'.match(ALLOW_RE);
    expect(m?.[1]).toBe('a1b2c3');
  });
  it('allow with uppercase id matches', () => {
    const m = 'ALLOW A1B2'.match(ALLOW_RE);
    expect(m?.[1]).toBe('A1B2');
  });
  it('deny with id matches', () => {
    const m = 'deny ff00ee'.match(DENY_RE);
    expect(m?.[1]).toBe('ff00ee');
  });
  it('allow with extra text does NOT match', () => expect(ALLOW_RE.test('allow me please')).toBe(false));
  it('deny without id has undefined group', () => {
    const m = 'deny'.match(DENY_RE);
    expect(m?.[1]).toBeUndefined();
  });
});

// ── Thread state file tests ───────────────────────────────────────────────────

describe('slack-thread.json state file', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'slack-thread-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reads thread state when file exists', () => {
    const state = { channel: 'C123', threadTs: '1.1', msgTs: '1.2' };
    writeFileSync(join(tmp, 'slack-thread.json'), JSON.stringify(state), 'utf-8');
    const loaded = JSON.parse(readFileSync(join(tmp, 'slack-thread.json'), 'utf-8'));
    expect(loaded.threadTs).toBe('1.1');
    expect(loaded.channel).toBe('C123');
  });

  it('returns undefined when file missing (hooks degrade gracefully)', () => {
    let threadTs: string | undefined;
    try {
      const s = JSON.parse(readFileSync(join(tmp, 'slack-thread.json'), 'utf-8'));
      if (s.channel === 'C999' && s.threadTs) threadTs = s.threadTs;
    } catch { /* expected */ }
    expect(threadTs).toBeUndefined();
  });

  it('ignores state from a different channel', () => {
    const state = { channel: 'C_OTHER', threadTs: '1.1', msgTs: '1.1' };
    writeFileSync(join(tmp, 'slack-thread.json'), JSON.stringify(state), 'utf-8');
    let threadTs: string | undefined;
    try {
      const s = JSON.parse(readFileSync(join(tmp, 'slack-thread.json'), 'utf-8'));
      if (s.channel === 'C123' && s.threadTs) threadTs = s.threadTs;
    } catch { /* expected */ }
    expect(threadTs).toBeUndefined();
  });
});

// ── Approval file ID-targeted resolution tests ────────────────────────────────

describe('approval file selection by shortId', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'approval-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writePending(id: string) {
    writeFileSync(
      join(tmp, `hook-response-${id}.pending`),
      JSON.stringify({ uniqueId: id, agentName: 'test', tool_name: 'Write', channelId: 'C1' }),
      'utf-8',
    );
  }

  it('selects file matching shortId over latest-mtime', () => {
    const older = 'aabbcc112233';
    const newer = 'ddeeff445566';
    writePending(older);
    // slight delay so mtime differs
    writePending(newer);

    // shortId targets the older one
    const shortId = older.slice(0, 6);
    const files = require('fs').readdirSync(tmp).filter((f: string) => f.endsWith('.pending'));
    const candidates = files.map((f: string) => {
      const meta = JSON.parse(require('fs').readFileSync(join(tmp, f), 'utf-8'));
      return { uniqueId: meta.uniqueId };
    });
    const chosen = candidates.find((c: { uniqueId: string }) => c.uniqueId.startsWith(shortId));
    expect(chosen?.uniqueId).toBe(older);
  });

  it('returns undefined when no file matches shortId', () => {
    writePending('aabbcc112233');
    const chosen = [{ uniqueId: 'aabbcc112233' }].find((c) => c.uniqueId.startsWith('ffffff'));
    expect(chosen).toBeUndefined();
  });
});
