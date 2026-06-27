/**
 * SlackAdapter — Slack implementation of ChannelAdapter.
 *
 * Phase A: validation + outbound + reply-target discovery (wraps SlackAPI).
 * Phase B: the inbound loop (start/stop) — ports SlackControlPlane's gates.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { SlackAPI } from '../../slack/api.js';
import type {
  ChannelAdapter,
  InboundHandlers,
  OutboundTarget,
  ValidationResult,
} from '../adapter.js';

export class SlackAdapter implements ChannelAdapter {
  readonly kind = 'slack';
  private api: SlackAPI;

  constructor(botToken: string) {
    this.api = new SlackAPI(botToken);
  }

  async validateCredentials(): Promise<ValidationResult> {
    try {
      const botUserId = await this.api.getBotUserId();
      if (botUserId) return { ok: true, identity: botUserId };
      return { ok: false, error: 'auth.test returned no user id — token may be invalid' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendMessage(target: OutboundTarget, text: string): Promise<{ messageId: string } | null> {
    const res = await this.api.sendMessage(target.conversationId, text, target.threadId);
    return res ? { messageId: res.ts } : null;
  }

  async addReaction(target: OutboundTarget, messageId: string, emoji: string): Promise<void> {
    await this.api.addReaction(target.conversationId, messageId, emoji);
  }

  /** Read the reply target the control plane persisted for the last inbound message. */
  resolveReplyTarget(stateDir: string): OutboundTarget | null {
    const path = join(stateDir, 'slack-thread.json');
    if (!existsSync(path)) return null;
    try {
      const { channel, threadTs } = JSON.parse(readFileSync(path, 'utf-8'));
      if (!channel) return null;
      return { conversationId: channel, threadId: threadTs || undefined };
    } catch {
      return null;
    }
  }

  // ── Inbound — Phase B ─────────────────────────────────────────────────────
  async start(_handlers: InboundHandlers): Promise<void> {
    throw new Error('SlackAdapter.start: inbound is wired in Phase B');
  }

  async stop(): Promise<void> {
    /* no-op until Phase B */
  }
}
