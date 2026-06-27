/**
 * ChannelAdapter — the abstraction that decouples officeOs from any single
 * messaging channel. Slack is the first concrete implementation; Mock is the
 * second (used in tests). Telegram, Teams, WhatsApp can each be added later as
 * one folder implementing this interface, with no changes here.
 *
 * Decomposition: an adapter owns transport + channel-specific authorization +
 * raw→normalized translation. The generic daemon core (channel-core, Phase B)
 * owns the shared pipeline — dedup, format, inject, thread-state, approval-file
 * writes — driven by the normalized IncomingMessage below.
 */

/** A normalized inbound message, stripped of channel-specific shape. */
export interface IncomingMessage {
  /** Channel kind that produced this message — 'slack', 'telegram', ... */
  kind: string;
  /** Channel-native sender id (Slack user id, Telegram user id). */
  senderId: string;
  /** Authorization role the adapter resolved for the sender. */
  senderRole: 'owner' | 'readonly' | 'unknown';
  /** Plain message text. */
  text: string;
  /** Where the message came from — Slack channel id / Telegram chat id. */
  conversationId: string;
  /** Channel-native message id — Slack ts / Telegram message_id. */
  messageId: string;
  /** Thread anchor, when the channel threads (Slack thread_ts). */
  threadId?: string;
  /** True when the text is a slash command (different sanitization). */
  isSlashCommand?: boolean;
  /** The original channel event, for anything the core can't express yet. */
  raw: unknown;
}

/** Where an outbound message should land. */
export interface OutboundTarget {
  conversationId: string;
  threadId?: string;
}

/** Result of a credential probe — used by onboarding and daemon preflight. */
export interface ValidationResult {
  ok: boolean;
  /** Channel identity on success — e.g. the bot's own user id. */
  identity?: string;
  /** Human-readable reason on failure. */
  error?: string;
}

/** Callbacks the daemon core hands to an adapter's inbound loop. */
export interface InboundHandlers {
  /** An authorized, normalized message arrived. */
  onMessage(msg: IncomingMessage): Promise<void> | void;
  /** The owner issued an approval decision (`allow <id>` / `deny <id>`). */
  onApproval(decision: 'allow' | 'deny', shortId: string | undefined, role: string): void;
}

/**
 * The full channel contract. Phase A implements validate + outbound; Phase B
 * implements the inbound loop (start/stop).
 */
export interface ChannelAdapter {
  /** Stable channel identifier — 'slack', 'telegram', 'mock'. */
  readonly kind: string;

  // ── Identity / validation (onboarding, preflight) ───────────────────────
  validateCredentials(): Promise<ValidationResult>;

  // ── Outbound (hooks, bus) ───────────────────────────────────────────────
  sendMessage(target: OutboundTarget, text: string): Promise<{ messageId: string } | null>;
  addReaction(target: OutboundTarget, messageId: string, emoji: string): Promise<void>;

  /**
   * Resolve where a hook should reply, from the agent's state dir. Slack reads
   * slack-thread.json; a future Telegram adapter would read chat id from .env.
   * Returns null when no target is known yet.
   */
  resolveReplyTarget(stateDir: string): OutboundTarget | null;

  // ── Inbound (daemon) — wired in Phase B ─────────────────────────────────
  start(handlers: InboundHandlers): Promise<void>;
  stop(): Promise<void>;
}

/** Context passed to the registry when resolving an adapter. */
export interface AdapterContext {
  /** Absolute agent directory (holds .env, state/, config.json). */
  agentDir?: string;
  /** Agent state dir for reply-target discovery. */
  stateDir?: string;
  /** Pre-read env map (agent .env merged with process.env), if available. */
  env?: Record<string, string | undefined>;
  /**
   * Explicit credentials, for callers that hold them before they're written to
   * disk (the onboarding wizard validating freshly-typed tokens).
   */
  botToken?: string;
  appToken?: string;
}
