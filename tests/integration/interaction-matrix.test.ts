/**
 * Human-use-case interaction matrix — the deterministic proof that correlation
 * never crosses, across the concurrency/DM/channel/fan-out cases that broke
 * before. Drives the real correlation primitives the daemon and bus use:
 * reply-targets (where a request's reply goes) + current-request (the daemon's
 * per-turn truth) + resolveRequestId (what an outbound command resolves to).
 *
 * These encode the cases a user actually hits: two people at once, a question in
 * a DM vs a channel thread, an agent that reuses or mistypes an id, a fan-out
 * with several requests in flight. Each must route to exactly the right place.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { recordTarget, getTarget } from '../../src/channels/reply-targets.js';
import { writeCurrentRequest, resolveRequestId } from '../../src/channels/current-request.js';

describe('interaction matrix — correlation never crosses', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'matrix-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** What an agent's `bus reply` (no id) routes to while the daemon processes `reqId`. */
  function replyTargetFor(reqId: string, typed?: string) {
    writeCurrentRequest(dir, [reqId]);
    const resolved = resolveRequestId(dir, typed);
    return resolved ? getTarget(dir, resolved) : null;
  }

  it('two users in different channels at once never cross', () => {
    recordTarget(dir, 'rA', { conversationId: 'C_ALICE', threadId: 'TA', role: 'owner' });
    recordTarget(dir, 'rB', { conversationId: 'C_BOB', threadId: 'TB', role: 'owner' });

    expect(replyTargetFor('rA')).toMatchObject({ conversationId: 'C_ALICE', threadId: 'TA' });
    expect(replyTargetFor('rB')).toMatchObject({ conversationId: 'C_BOB', threadId: 'TB' });
  });

  it('two questions in the same DM land on their own threads', () => {
    recordTarget(dir, 'q1', { conversationId: 'D_USER', threadId: 'T1' });
    recordTarget(dir, 'q2', { conversationId: 'D_USER', threadId: 'T2' });

    expect(replyTargetFor('q1')?.threadId).toBe('T1');
    expect(replyTargetFor('q2')?.threadId).toBe('T2');
  });

  it('DM + channel mix: each reply lands on its own conversation', () => {
    recordTarget(dir, 'rDM', { conversationId: 'D_USER' });            // DM, no thread
    recordTarget(dir, 'rCh', { conversationId: 'C_TEAM', threadId: 'TC' }); // channel thread

    expect(replyTargetFor('rDM')).toMatchObject({ conversationId: 'D_USER' });
    expect(replyTargetFor('rCh')).toMatchObject({ conversationId: 'C_TEAM', threadId: 'TC' });
  });

  it('an agent that REUSES a stale id is corrected to the current request', () => {
    recordTarget(dir, 'rA', { conversationId: 'C_ALICE', threadId: 'TA' });
    recordTarget(dir, 'rB', { conversationId: 'C_BOB', threadId: 'TB' });
    // Daemon is processing B; the agent (LLM) pastes A's id from earlier context.
    expect(replyTargetFor('rB', 'rA')).toMatchObject({ conversationId: 'C_BOB', threadId: 'TB' });
  });

  it('an agent that CORRUPTS the id (dropped char) is corrected to the current request', () => {
    recordTarget(dir, 'mqwtmq88-kgsoh', { conversationId: 'C_ALICE', threadId: 'TA' });
    // current turn is this request; agent retypes it wrong.
    expect(replyTargetFor('mqwtmq88-kgsoh', 'mqwtmq88-kgoh')).toMatchObject({ conversationId: 'C_ALICE', threadId: 'TA' });
  });

  it('fan-out: an explicit id that belongs to the turn is honoured (disambiguation)', () => {
    recordTarget(dir, 'rA', { conversationId: 'C_ALICE', threadId: 'TA' });
    recordTarget(dir, 'rB', { conversationId: 'C_BOB', threadId: 'TB' });
    writeCurrentRequest(dir, ['rA', 'rB']); // both in flight this turn
    expect(getTarget(dir, resolveRequestId(dir, 'rA')!)).toMatchObject({ conversationId: 'C_ALICE' });
    expect(getTarget(dir, resolveRequestId(dir, 'rB')!)).toMatchObject({ conversationId: 'C_BOB' });
  });

  it('a readonly reply in an owner thread never flips the conversation to readonly', () => {
    recordTarget(dir, 'r1', { conversationId: 'C_TEAM', threadId: 'T1', role: 'owner' });
    recordTarget(dir, 'r1', { conversationId: 'C_TEAM', threadId: 'T1', role: 'readonly' }); // readonly replies in-thread
    expect(getTarget(dir, 'r1')?.role).toBe('owner');
  });

  it('a thread-inherited reply routes back to the original asker (ASK_HUMAN round-trip)', () => {
    // Agent asked a question; it was posted in C_TEAM thread T1 under request rAsk.
    recordTarget(dir, 'rAsk', { conversationId: 'C_TEAM', threadId: 'T1', role: 'owner' });
    // The human's in-thread answer inherits rAsk → relays back to the same place.
    expect(replyTargetFor('rAsk')).toMatchObject({ conversationId: 'C_TEAM', threadId: 'T1' });
  });
});
