import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MockAdapter, MOCK_BOT_IDENTITY } from '../../../src/channels/mock/mock-adapter.js';

describe('MockAdapter', () => {
  let dir: string;
  let savedOutbox: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mock-adapter-'));
    savedOutbox = process.env.OFFICEOS_MOCK_OUTBOX;
  });

  afterEach(() => {
    if (savedOutbox === undefined) delete process.env.OFFICEOS_MOCK_OUTBOX;
    else process.env.OFFICEOS_MOCK_OUTBOX = savedOutbox;
    rmSync(dir, { recursive: true, force: true });
  });

  it('validateCredentials resolves ok with a deterministic identity', async () => {
    const res = await new MockAdapter().validateCredentials();
    expect(res).toEqual({ ok: true, identity: MOCK_BOT_IDENTITY });
  });

  it('records sendMessage to OFFICEOS_MOCK_OUTBOX', async () => {
    const outbox = join(dir, 'outbox.jsonl');
    process.env.OFFICEOS_MOCK_OUTBOX = outbox;
    const a = new MockAdapter();
    const res = await a.sendMessage({ conversationId: 'C1', threadId: 'T1' }, 'hello');
    expect(res).toEqual({ messageId: 'mock-ts-1' });
    expect(existsSync(outbox)).toBe(true);
    const line = JSON.parse(readFileSync(outbox, 'utf-8').trim());
    expect(line).toMatchObject({ op: 'sendMessage', text: 'hello', target: { conversationId: 'C1', threadId: 'T1' } });
  });

  it('records addReaction', async () => {
    const outbox = join(dir, 'outbox.jsonl');
    process.env.OFFICEOS_MOCK_OUTBOX = outbox;
    await new MockAdapter().addReaction({ conversationId: 'C1' }, 'ts9', 'eyes');
    const line = JSON.parse(readFileSync(outbox, 'utf-8').trim());
    expect(line).toMatchObject({ op: 'addReaction', emoji: 'eyes', messageId: 'ts9' });
  });

  it('sendMessage is a no-op sink when no outbox is set', async () => {
    delete process.env.OFFICEOS_MOCK_OUTBOX;
    const res = await new MockAdapter().sendMessage({ conversationId: 'C1' }, 'x');
    expect(res).toEqual({ messageId: 'mock-ts-1' });
  });

  it('start/stop are no-ops', async () => {
    const a = new MockAdapter();
    await expect(a.start({ onMessage: () => {}, onApproval: () => {} })).resolves.toBeUndefined();
    await expect(a.stop()).resolves.toBeUndefined();
  });
});
