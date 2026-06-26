import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { SlackAPI } from './api.js';
import { SlackSocketClient } from './socket-client.js';
import { stripControlChars, sanitizeForPtyInjection, wrapFenceSafe } from '../utils/validate.js';
import type { AgentConfig } from '../types/index.js';

type LogFn = (msg: string) => void;

interface FastCheckerLike {
  queueSlackMessage(formatted: string): void;
  isDuplicate(text: string): boolean;
}

interface AgentEntry {
  api: SlackAPI;
  socket: SlackSocketClient;
  stateDir: string;
  ownerId: string;
  readonlyIds: Set<string>;
  allowedChannels: Set<string>;  // empty = accept configured channel + DMs only
  allowedDomains: Set<string>;   // empty = no domain check
  domainCache: Map<string, boolean>; // userId → passes domain check
}

const ALLOW_RE = /^allow$/i;
const DENY_RE  = /^deny$/i;

// ── Approval file handler ────────────────────────────────────────────────────
function writeApprovalResponse(stateDir: string, decision: 'allow' | 'deny', log: LogFn): void {
  let latest: { path: string; mtime: number; prefix: string } | null = null;

  for (const prefix of ['hook-response', 'tool-approval']) {
    try {
      const { readdirSync, statSync } = require('fs');
      const files = readdirSync(stateDir).filter(
        (f: string) => f.startsWith(prefix + '-') && f.endsWith('.pending'),
      );
      for (const f of files) {
        const p = join(stateDir, f);
        const mtime = statSync(p).mtimeMs;
        if (!latest || mtime > latest.mtime) latest = { path: p, mtime, prefix };
      }
    } catch { /* stateDir may not exist yet */ }
  }

  if (!latest) { log(`Slack: got "${decision}" but no pending approval files`); return; }

  try {
    const meta = JSON.parse(readFileSync(latest.path, 'utf-8'));
    const uniqueId = meta.uniqueId || meta.approvalId;
    if (!uniqueId) { log(`Slack: pending file missing uniqueId: ${latest.path}`); return; }
    const responseFile = join(stateDir, `${latest.prefix}-${uniqueId}.json`);
    writeFileSync(responseFile, JSON.stringify({ decision, ts: Date.now() }), 'utf-8');
    log(`Slack: approval written: ${decision} → ${latest.prefix}-${uniqueId}.json`);
    try { unlinkSync(latest.path); } catch {}
  } catch (err: any) {
    log(`Slack: approval write error: ${err.message}`);
  }
}

// ── Domain check via Slack users.info API ────────────────────────────────────
async function checkDomain(
  botToken: string,
  userId: string,
  allowedDomains: Set<string>,
  cache: Map<string, boolean>,
  log: LogFn,
): Promise<boolean> {
  if (allowedDomains.size === 0) return true;  // no domain restriction

  const cached = cache.get(userId);
  if (cached !== undefined) return cached;

  try {
    const res = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const data = await res.json() as any;
    const email: string = data?.user?.profile?.email || '';
    const domain = email.split('@')[1]?.toLowerCase() || '';
    const passes = allowedDomains.has(domain);
    cache.set(userId, passes);
    if (!passes) log(`Slack: rejected user ${userId} — email domain "${domain}" not in allowlist`);
    return passes;
  } catch (err: any) {
    log(`Slack: domain check failed for ${userId}: ${err.message} — denying`);
    cache.set(userId, false);
    return false;
  }
}

// ── SlackControlPlane ────────────────────────────────────────────────────────
export class SlackControlPlane {
  private agents = new Map<string, AgentEntry>();

  constructor(_frameworkRoot: string) {}

  async init(
    name: string,
    agentDir: string,
    checker: FastCheckerLike,
    config: AgentConfig,
    log: LogFn,
    ctxRoot: string,
  ): Promise<void> {
    if (config.slack_polling === false) return;

    const envFile = join(agentDir, '.env');
    if (!existsSync(envFile)) return;

    const env = readFileSync(envFile, 'utf-8');
    const get = (key: string) => env.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim() || '';

    const botToken  = get('SLACK_BOT_TOKEN');
    const appToken  = get('SLACK_APP_TOKEN');
    const ownerId   = get('SLACK_USER_ID');

    // Support both SLACK_CHANNEL_ID (single) and SLACK_ALLOWED_CHANNELS (multi)
    const singleChannel    = get('SLACK_CHANNEL_ID');
    const multiChannels    = get('SLACK_ALLOWED_CHANNELS');
    const allowedChannels  = new Set(
      (multiChannels || singleChannel).split(',').map((s) => s.trim()).filter(Boolean),
    );

    const readonlyIds = new Set(
      get('SLACK_READONLY_USERS').split(',').map((s) => s.trim()).filter(Boolean),
    );

    const allowedDomains = new Set(
      get('SLACK_ALLOWED_DOMAINS').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    );

    if (!botToken || !appToken) return;

    if (!ownerId) {
      log('Slack: SLACK_USER_ID not set — refusing to start. Without an explicit owner ID anyone in the workspace could control the agent.');
      return;
    }

    if (allowedChannels.size === 0) {
      log('Slack: no channel configured (SLACK_CHANNEL_ID or SLACK_ALLOWED_CHANNELS) — only DMs from owner will be accepted');
    }

    const stateDir    = join(ctxRoot, 'state', name);
    const domainCache = new Map<string, boolean>();
    mkdirSync(stateDir, { recursive: true });

    const api    = new SlackAPI(botToken);
    const socket = new SlackSocketClient(appToken);

    socket.onMessage(async (event) => {
      const userId = event.user || '';
      const isOwner    = userId === ownerId;
      const isReadonly = readonlyIds.has(userId);

      // Gate 1: only known users
      if (!isOwner && !isReadonly) {
        if (userId) log(`Slack: ignoring unknown user ${userId}`);
        return;
      }

      // Gate 2: channel allowlist — DMs from owner always pass; others must match
      const isDM = event.channel_type === 'im';
      if (isDM && !isOwner) {
        // Readonly users can DM if explicitly allowed — no extra channel restriction
      } else if (!isDM) {
        if (allowedChannels.size > 0 && !allowedChannels.has(event.channel)) {
          // Silently ignore — bot is in many channels, no need to spam logs for every one
          return;
        }
      }

      // Gate 3: email domain check (async, cached)
      const domainOk = await checkDomain(botToken, userId, allowedDomains, domainCache, log);
      if (!domainOk) return;

      const text = (event.text || '').trim();

      // Gate 4: approval routing — OWNER only
      if (isOwner) {
        if (ALLOW_RE.test(text)) { writeApprovalResponse(stateDir, 'allow', log); return; }
        if (DENY_RE.test(text))  { writeApprovalResponse(stateDir, 'deny',  log); return; }
      } else if (ALLOW_RE.test(text) || DENY_RE.test(text)) {
        log(`Slack: ${userId} (readonly) attempted approval — blocked`);
        return;
      }

      // Inject into agent PTY
      const from = stripControlChars(userId || 'slack-user');
      const isSlashCommand = /^\/[a-zA-Z]/.test(stripControlChars(text).trim());
      const body = isSlashCommand
        ? sanitizeForPtyInjection(text).trim()
        : wrapFenceSafe(text);

      // Structural label only — no prompt instructions. Put topic restrictions in agent's CLAUDE.md.
      const roleTag = isOwner ? 'OWNER' : 'READONLY';
      const formatted = `=== SLACK from [USER: ${sanitizeForPtyInjection(from)}] [${roleTag}] (channel:${event.channel}) ===\n${body}\nReply using: officeos bus send-slack ${event.channel} '<your reply>'\n\n`;

      if (!checker.isDuplicate(formatted)) {
        checker.queueSlackMessage(formatted);
        log(`Slack: queued message from ${from} [${roleTag}]`);
      }
    });

    // Gate: auto-eject if someone other than the owner invites the bot to a channel.
    socket.onEvent('member_joined_channel', async (ev) => {
      const joiningUser = ev.user as string;
      const inviter     = ev.inviter as string | undefined;
      const channel     = ev.channel as string;

      // Only act when the bot itself joined — not other users joining channels.
      const botUserId = await api.getBotUserId();
      if (!botUserId || joiningUser !== botUserId) return;

      if (inviter !== ownerId) {
        log(`Slack: bot added to ${channel} by unauthorized user ${inviter ?? 'unknown'} — ejecting`);
        await api.leaveChannel(channel);
        await api.dmUser(ownerId, `OfficeOs bot was added to <#${channel}> by <@${inviter ?? 'unknown'}>. Auto-ejected. Only you can add the bot to channels.`);
      } else {
        // Owner added it — accept and add to runtime channel allowlist
        allowedChannels.add(channel);
        log(`Slack: joined channel ${channel} (invited by owner)`);
      }
    });

    const summary = [
      `owner: ${ownerId}`,
      readonlyIds.size > 0 ? `readonly: [${[...readonlyIds].join(', ')}]` : null,
      allowedChannels.size > 0 ? `channels: [${[...allowedChannels].join(', ')}]` : 'DM-only',
      allowedDomains.size > 0 ? `domains: [${[...allowedDomains].join(', ')}]` : null,
    ].filter(Boolean).join(', ');

    try {
      await socket.start();
      this.agents.set(name, { api, socket, stateDir, ownerId, readonlyIds, allowedChannels, allowedDomains, domainCache });
      log(`Slack: Socket Mode connected (${summary})`);
    } catch (err: any) {
      log(`Slack: socket start failed: ${err.message}`);
    }
  }

  async cleanup(name: string): Promise<void> {
    const entry = this.agents.get(name);
    if (!entry) return;
    try { await entry.socket.stop(); } catch {}
    this.agents.delete(name);
  }

  getAPI(name: string): SlackAPI | undefined {
    return this.agents.get(name)?.api;
  }

  getChannelId(name: string): string | undefined {
    return this.agents.get(name)?.allowedChannels.values().next().value;
  }
}
