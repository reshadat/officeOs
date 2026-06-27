/**
 * Channel message loop — integration.
 *
 * Exercises the real pipeline around the (non-deterministic) agent brain:
 *   inbound:   adapter → channel-core handlers → FastChecker → agent.injectMessage
 *   outbound:  agent reply → adapter.sendMessage → wire
 *   approval:  owner "allow <id>" → onApproval → approval file → hook unblocks
 *   inter-agent: ROUTED_QUERY over the file bus → ROUTE_REPLY back
 *
 * The LLM step itself is stubbed (the agent is a spy); everything else is real.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, writeFileSync as wf } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { vi } from 'vitest';
import type { BusPaths } from '../../src/types/index.js';
import { FastChecker } from '../../src/daemon/fast-checker.js';
import { makeChannelHandlers } from '../../src/daemon/channel-core.js';
import { MockAdapter } from '../../src/channels/mock/mock-adapter.js';
import { sendToReplyTarget } from '../../src/channels/send.js';
import { sendMessage, checkInbox, ackInbox } from '../../src/bus/message.js';
import { recordTarget, getTarget, activeConversations } from '../../src/channels/reply-targets.js';
import type { IncomingMessage } from '../../src/channels/adapter.js';

function mockAgent(name = 'orch') {
  return { name, isBootstrapped: vi.fn().mockReturnValue(true), injectMessage: vi.fn().mockReturnValue(true), write: vi.fn() } as any;
}

function makePaths(ctxRoot: string, agent: string): BusPaths {
  const p: BusPaths = {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agent),
    inflight: join(ctxRoot, 'inflight', agent),
    processed: join(ctxRoot, 'processed', agent),
    logDir: join(ctxRoot, 'logs', agent),
    stateDir: join(ctxRoot, 'state', agent),
    taskDir: join(ctxRoot, 'orgs', 'test-org', 'tasks'),
    approvalDir: join(ctxRoot, 'orgs', 'test-org', 'approvals'),
    analyticsDir: join(ctxRoot, 'orgs', 'test-org', 'analytics'),
    heartbeatDir: join(ctxRoot, 'heartbeats'),
  };
  for (const d of Object.values(p)) if (d !== ctxRoot) mkdirSync(d, { recursive: true });
  return p;
}

const incoming = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  kind: 'slack', senderId: 'U1', senderRole: 'owner', text: 'what shipped overnight?',
  conversationId: 'C1', messageId: '1700.1', injection: '=== SLACK from [USER: U1] [OWNER] (channel:C1) ===\nwhat shipped overnight?\n',
  raw: {}, ...over,
});

describe('channel message loop', () => {
  let ctxRoot: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'chan-loop-'));
    for (const k of ['OFFICEOS_CHANNEL_ADAPTER', 'OFFICEOS_MOCK_OUTBOX', 'OFFICEOS_MOCK_INBOX', 'SLACK_BOT_TOKEN']) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  // ── INBOUND: message → bus → agent ─────────────────────────────────────────
  it('inbound: a queued message is injected into the agent via the bus poll cycle', async () => {
    const agent = mockAgent();
    const paths = makePaths(ctxRoot, 'orch');
    const checker = new FastChecker(agent, paths, join(ctxRoot, 'fw'));
    const handlers = makeChannelHandlers(checker, paths.stateDir, () => {});

    handlers.onMessage(incoming({ injection: 'INJECT-BLOCK-1' }));
    await (checker as any).pollCycle();

    expect(agent.injectMessage).toHaveBeenCalledTimes(1);
    expect(agent.injectMessage.mock.calls[0][0]).toContain('INJECT-BLOCK-1');
  });

  it('inbound: duplicate messages are injected once (dedup)', async () => {
    const agent = mockAgent();
    const paths = makePaths(ctxRoot, 'orch');
    const checker = new FastChecker(agent, paths, join(ctxRoot, 'fw'));
    const handlers = makeChannelHandlers(checker, paths.stateDir, () => {});

    handlers.onMessage(incoming({ injection: 'DUP-BLOCK' }));
    handlers.onMessage(incoming({ injection: 'DUP-BLOCK' }));
    await (checker as any).pollCycle();

    expect(agent.injectMessage).toHaveBeenCalledTimes(1);
  });

  it('inbound: MockAdapter.start replays a scripted inbox through to the agent', async () => {
    const agent = mockAgent();
    const paths = makePaths(ctxRoot, 'orch');
    const checker = new FastChecker(agent, paths, join(ctxRoot, 'fw'));
    const handlers = makeChannelHandlers(checker, paths.stateDir, () => {});

    const inbox = join(ctxRoot, 'mock-inbox.jsonl');
    writeFileSync(inbox, JSON.stringify(incoming({ injection: 'SCRIPTED-1' })) + '\n');
    process.env.OFFICEOS_MOCK_INBOX = inbox;

    await new MockAdapter().start(handlers);
    await (checker as any).pollCycle();

    expect(agent.injectMessage).toHaveBeenCalledTimes(1);
    expect(agent.injectMessage.mock.calls[0][0]).toContain('SCRIPTED-1');
  });

  // ── APPROVAL: owner "allow <id>" → approval file the hook waits on ──────────
  it('approval: an owner allow decision writes the response file the permission hook polls', async () => {
    const paths = makePaths(ctxRoot, 'orch');
    const handlers = makeChannelHandlers({ queueSlackMessage: () => {}, isDuplicate: () => false }, paths.stateDir, () => {});
    // a permission hook would have written this pending marker:
    wf(join(paths.stateDir, 'hook-response-abc123.pending'), JSON.stringify({ uniqueId: 'abc123' }));

    // owner types "allow abc123" in Slack → adapter routes to onApproval
    handlers.onApproval('allow', 'abc123', 'owner');

    const responseFile = join(paths.stateDir, 'hook-response-abc123.json');
    expect(existsSync(responseFile)).toBe(true);
    expect(JSON.parse(readFileSync(responseFile, 'utf-8')).decision).toBe('allow');
  });

  // ── OUTBOUND: agent reply → adapter → wire ─────────────────────────────────
  it('outbound: a hook reply lands UNTHREADED on the owner channel', async () => {
    const paths = makePaths(ctxRoot, 'orch');
    recordTarget(paths.stateDir, 'req-1', { conversationId: 'C1', threadId: '1700.1', role: 'owner' });

    const outbox = join(ctxRoot, 'outbox.jsonl');
    process.env.OFFICEOS_CHANNEL_ADAPTER = 'mock';
    process.env.OFFICEOS_MOCK_OUTBOX = outbox;
    const agentDir = join(ctxRoot, 'agent');
    mkdirSync(agentDir, { recursive: true });
    wf(join(agentDir, '.env'), 'SLACK_BOT_TOKEN=xoxb-1\nSLACK_CHANNEL_ID=C1\n');

    const res = await sendToReplyTarget(agentDir, paths.stateDir, 'all green');
    expect(res).toEqual({ messageId: 'mock-ts-1' });
    const sent = JSON.parse(readFileSync(outbox, 'utf-8').trim());
    // Hook prompt posts top-level to the owner channel — never into a thread.
    expect(sent.op).toBe('sendMessage');
    expect(sent.text).toBe('all green');
    expect(sent.target.conversationId).toBe('C1');
    expect(sent.target.threadId).toBeUndefined();
  });

  // ── INTER-AGENT: ROUTED_QUERY → ROUTE_REPLY over the file bus ───────────────
  it('inter-agent: orchestrator routes a query and the specialist replies over the bus', () => {
    const orch = makePaths(ctxRoot, 'orch');
    const analyst = makePaths(ctxRoot, 'analyst');

    // orch → analyst
    const qId = sendMessage(orch, 'orch', 'analyst', 'high', 'ROUTED_QUERY: summarize nightly metrics');
    const got = checkInbox(analyst);
    expect(got).toHaveLength(1);
    expect(got[0].from).toBe('orch');
    expect(got[0].text).toMatch(/^ROUTED_QUERY:/);
    ackInbox(analyst, qId);

    // analyst → orch (reply references the original)
    const rId = sendMessage(analyst, 'analyst', 'orch', 'high', 'ROUTE_REPLY: no anomalies', qId);
    const reply = checkInbox(orch);
    expect(reply).toHaveLength(1);
    expect(reply[0].text).toMatch(/^ROUTE_REPLY:/);
    ackInbox(orch, rId);

    // both inboxes drained
    expect(checkInbox(orch)).toHaveLength(0);
    expect(checkInbox(analyst)).toHaveLength(0);
  });

  // ── CONCURRENT USERS: the BLOCKER — A's reply survives B's later message ─────
  it('two users in different channels: both reply targets stay resolvable (no overwrite)', () => {
    const paths = makePaths(ctxRoot, 'orch');
    recordTarget(paths.stateDir, 'reqA', { conversationId: 'C_A', threadId: 'tA' }, 1000);
    recordTarget(paths.stateDir, 'reqB', { conversationId: 'C_B', threadId: 'tB' }, 1001); // B after A

    // A still resolves to C_A even though B (C_B) arrived later.
    expect(getTarget(paths.stateDir, 'reqA', 1002)).toMatchObject({ conversationId: 'C_A', threadId: 'tA' });
    // The outbound gate would allow a reply to BOTH channels (the old single-file
    // gate would have dropped A's reply once B overwrote it).
    expect(activeConversations(paths.stateDir, 1002)).toEqual(new Set(['C_A', 'C_B']));
  });

  // ── CORRELATION: origin survives the agent→agent hop ────────────────────────
  it('inter-agent: request_id + origin_channel round-trip through the bus', () => {
    const orch = makePaths(ctxRoot, 'orch');
    const analyst = makePaths(ctxRoot, 'analyst');
    sendMessage(orch, 'orch', 'analyst', 'high', 'ROUTED_QUERY: [req:r1] check metrics', undefined,
      { request_id: 'r1', origin_channel: 'C_A' });
    const got = checkInbox(analyst);
    expect(got[0].request_id).toBe('r1');
    expect(got[0].origin_channel).toBe('C_A');
  });

  // ── SERIALIZATION: one request per turn (two replies never share a thread) ──
  const slackFmt = (ch: string, txt: string, req = 'r') =>
    `=== SLACK from [USER: U] [OWNER] (channel:${ch}) [ts:1] [thread:1] [req:${req}] ===\n${txt}\nReply: x\n\n`;

  it('serialization: distinct requests inject ONE per turn (no merge)', async () => {
    const agent = mockAgent();
    const checker = new FastChecker(agent, makePaths(ctxRoot, 'orch'), join(ctxRoot, 'fw'));
    checker.queueSlackMessage(slackFmt('C_A', 'from Alice', 'rA'));
    checker.queueSlackMessage(slackFmt('C_B', 'from Bob', 'rB'));

    await (checker as any).pollCycle();
    expect(agent.injectMessage).toHaveBeenCalledTimes(1);
    const turn1 = agent.injectMessage.mock.calls[0][0];
    expect(turn1).toContain('from Alice');
    expect(turn1).not.toContain('from Bob'); // Bob's request is NOT in Alice's turn

    // Simulate the Stop hook firing (agent finished the turn) so the idle gate
    // lets the next request through.
    (checker as any).lastInjectAt = 0;
    await (checker as any).pollCycle();
    expect(agent.injectMessage.mock.calls[1][0]).toContain('from Bob');
  }, 20000);

  it('idle gate: no new request is injected while the agent is still busy', async () => {
    const agent = mockAgent();
    const checker = new FastChecker(agent, makePaths(ctxRoot, 'orch'), join(ctxRoot, 'fw'));
    checker.queueSlackMessage(slackFmt('C_A', 'from Alice', 'rA'));
    checker.queueSlackMessage(slackFmt('C_B', 'from Bob', 'rB'));

    await (checker as any).pollCycle();
    expect(agent.injectMessage).toHaveBeenCalledTimes(1); // Alice injected
    await (checker as any).pollCycle();
    // No last_idle.flag written → agent still busy → Bob NOT injected yet.
    expect(agent.injectMessage).toHaveBeenCalledTimes(1);
  }, 20000);

  it('daemon stamps current-request with ONLY the request being processed this turn', async () => {
    const agent = mockAgent();
    const paths = makePaths(ctxRoot, 'orch');
    const checker = new FastChecker(agent, paths, join(ctxRoot, 'fw'));
    checker.queueSlackMessage(slackFmt('C_A', 'alice', 'rA'));
    checker.queueSlackMessage(slackFmt('C_B', 'bob', 'rB'));

    await (checker as any).pollCycle();
    const cur = JSON.parse(readFileSync(join(paths.stateDir, 'current-request.json'), 'utf-8'));
    expect(cur.request_ids).toEqual(['rA']); // the one being processed, never both
  }, 20000);

  it('drain-on-failure: a failed inject does not drop the message', async () => {
    const agent = mockAgent();
    agent.injectMessage.mockReturnValueOnce(false); // first inject fails (e.g. session refresh)
    const checker = new FastChecker(agent, makePaths(ctxRoot, 'orch'), join(ctxRoot, 'fw'));
    checker.queueSlackMessage(slackFmt('C1', 'do not lose me'));

    await (checker as any).pollCycle(); // fails — must NOT drop
    await (checker as any).pollCycle(); // retried — succeeds
    expect(agent.injectMessage).toHaveBeenCalledTimes(2);
    expect(agent.injectMessage.mock.calls[1][0]).toContain('do not lose me');
  }, 20000);
});
