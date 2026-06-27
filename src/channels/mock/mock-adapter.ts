/**
 * MockAdapter — deterministic in-memory channel for tests. Proves the
 * ChannelAdapter abstraction is pluggable without any network. The black-box
 * CLI E2E selects this via OFFICEOS_CHANNEL_ADAPTER=mock so a spawned
 * `officeos onboard` validates credentials with zero Slack calls.
 *
 * Outbound calls append to the JSONL file at OFFICEOS_MOCK_OUTBOX (when set) so
 * a parent test process can assert on what was "sent".
 */
import { appendFileSync } from 'fs';
import type {
  ChannelAdapter,
  InboundHandlers,
  OutboundTarget,
  ValidationResult,
} from '../adapter.js';

/** Stable fake bot identity. Must differ from any owner id a test scripts. */
export const MOCK_BOT_IDENTITY = 'UBOTMOCK01';

export class MockAdapter implements ChannelAdapter {
  readonly kind = 'mock';

  async validateCredentials(): Promise<ValidationResult> {
    return { ok: true, identity: MOCK_BOT_IDENTITY };
  }

  async sendMessage(target: OutboundTarget, text: string): Promise<{ messageId: string } | null> {
    this.record({ op: 'sendMessage', target, text });
    return { messageId: 'mock-ts-1' };
  }

  async addReaction(target: OutboundTarget, messageId: string, emoji: string): Promise<void> {
    this.record({ op: 'addReaction', target, messageId, emoji });
  }

  resolveReplyTarget(): OutboundTarget | null {
    return { conversationId: 'C_MOCK', threadId: undefined };
  }

  async start(_handlers: InboundHandlers): Promise<void> {
    /* no scripted inbound by default */
  }

  async stop(): Promise<void> {
    /* no-op */
  }

  private record(entry: Record<string, unknown>): void {
    const outbox = process.env.OFFICEOS_MOCK_OUTBOX;
    if (!outbox) return;
    try {
      appendFileSync(outbox, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      /* best-effort — tests that care set a writable path */
    }
  }
}
