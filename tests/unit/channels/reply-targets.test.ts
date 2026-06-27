import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { recordTarget, getTarget, mostRecentTarget, activeConversations, getRequestIdForThread, mostRecentTargetForRole } from '../../../src/channels/reply-targets.js';

describe('reply-targets store (per-request, channel-agnostic)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'reply-targets-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('records and looks up a target by request id', () => {
    recordTarget(dir, 'rA', { conversationId: 'C1', threadId: 'T1', messageId: 'M1' });
    expect(getTarget(dir, 'rA')).toMatchObject({ conversationId: 'C1', threadId: 'T1', messageId: 'M1' });
    expect(getTarget(dir, 'missing')).toBeNull();
  });

  it('keeps DISTINCT targets for concurrent requests (the core fix)', () => {
    recordTarget(dir, 'rA', { conversationId: 'C1', threadId: 'T1' }, 1000);
    recordTarget(dir, 'rB', { conversationId: 'C2', threadId: 'T2' }, 1001); // B arrives after A
    // A is still resolvable to C1 even though B (C2) came later — no overwrite.
    expect(getTarget(dir, 'rA', 1002)).toMatchObject({ conversationId: 'C1' });
    expect(getTarget(dir, 'rB', 1002)).toMatchObject({ conversationId: 'C2' });
  });

  it('activeConversations returns the set of recent channels', () => {
    recordTarget(dir, 'rA', { conversationId: 'C1' }, 1000);
    recordTarget(dir, 'rB', { conversationId: 'C2' }, 1001);
    expect(activeConversations(dir, 1002)).toEqual(new Set(['C1', 'C2']));
  });

  it('mostRecentTarget returns the newest', () => {
    recordTarget(dir, 'rA', { conversationId: 'C1' }, 1000);
    recordTarget(dir, 'rB', { conversationId: 'C2' }, 5000);
    expect(mostRecentTarget(dir, 5001)).toMatchObject({ conversationId: 'C2' });
  });

  it('expires targets past the TTL', () => {
    const t0 = 1_000_000;
    recordTarget(dir, 'rOld', { conversationId: 'C1' }, t0);
    const later = t0 + 61 * 60 * 1000; // > 60 min
    expect(getTarget(dir, 'rOld', later)).toBeNull();
    expect(activeConversations(dir, later).size).toBe(0);
  });

  it('maps a (channel,thread) to its owning request, first-writer-wins', () => {
    recordTarget(dir, 'r1', { conversationId: 'C1', threadId: 'T1', role: 'owner' }, 1000);
    expect(getRequestIdForThread(dir, 'C1', 'T1', 1001)).toBe('r1');
    // a later message in the same thread must NOT steal the thread's id
    recordTarget(dir, 'r2', { conversationId: 'C1', threadId: 'T1', role: 'owner' }, 1002);
    expect(getRequestIdForThread(dir, 'C1', 'T1', 1003)).toBe('r1');
    // same thread ts in a DIFFERENT channel is a different thread (no collision)
    expect(getRequestIdForThread(dir, 'C_OTHER', 'T1', 1003)).toBeNull();
    expect(getRequestIdForThread(dir, 'C1', 'unknown', 1003)).toBeNull();
  });

  it('role is the immutable root — a readonly reply never flips an owner thread', () => {
    recordTarget(dir, 'r1', { conversationId: 'C1', threadId: 'T1', role: 'owner' }, 1000);
    // readonly actor replies in the owner thread (inherits r1) — role stays owner
    recordTarget(dir, 'r1', { conversationId: 'C1', threadId: 'T1', role: 'readonly' }, 1001);
    expect(getTarget(dir, 'r1', 1002)?.role).toBe('owner');
    // and a readonly-rooted request is never upgraded to owner
    recordTarget(dir, 'r2', { conversationId: 'C2', threadId: 'T2', role: 'readonly' }, 1000);
    recordTarget(dir, 'r2', { conversationId: 'C2', threadId: 'T2', role: 'owner' }, 1001);
    expect(getTarget(dir, 'r2', 1002)?.role).toBe('readonly');
  });

  it('mostRecentTargetForRole ignores readonly when finding the owner thread', () => {
    recordTarget(dir, 'rOwner', { conversationId: 'C_OWN', threadId: 'TO', role: 'owner' }, 1000);
    recordTarget(dir, 'rRead', { conversationId: 'C_OWN', threadId: 'TR', role: 'readonly' }, 2000); // readonly later
    expect(mostRecentTargetForRole(dir, 'owner', 2001)).toMatchObject({ conversationId: 'C_OWN', threadId: 'TO' });
  });

  it('survives a corrupt store file', () => {
    recordTarget(dir, 'rA', { conversationId: 'C1' });
    // corrupt then re-read — should not throw, just treat as empty/fresh
    rmSync(join(dir, 'reply-targets.json'));
    expect(getTarget(dir, 'rA')).toBeNull();
    expect(() => recordTarget(dir, 'rB', { conversationId: 'C2' })).not.toThrow();
  });
});
