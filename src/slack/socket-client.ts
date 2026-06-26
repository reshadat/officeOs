import { SocketModeClient } from '@slack/socket-mode';
import type { SlackMessageEvent } from '../types/index.js';

type MessageHandler = (event: SlackMessageEvent) => void | Promise<void>;
type EventHandler = (event: Record<string, unknown>) => void | Promise<void>;

export class SlackSocketClient {
  private client: SocketModeClient;
  private messageHandlers: MessageHandler[] = [];
  private eventHandlers = new Map<string, EventHandler[]>();

  constructor(appToken: string) {
    this.client = new SocketModeClient({ appToken });

    this.client.on('message', ({ event }: { event: unknown }) => {
      const ev = event as SlackMessageEvent;
      if (ev && ev.type === 'message' && ev.text && !ev.bot_id) {
        for (const handler of this.messageHandlers) {
          void handler(ev);
        }
      }
    });

    // Route any other event type registered via onEvent()
    this.client.on('events_api', ({ body }: { body: unknown }) => {
      const b = body as any;
      const ev = b?.event as Record<string, unknown>;
      if (!ev?.type) return;
      const handlers = this.eventHandlers.get(ev.type as string);
      if (handlers) {
        for (const h of handlers) void h(ev);
      }
    });

    this.client.on('error', (err: Error) => {
      console.error('[slack-socket] error:', err.message);
    });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onEvent(type: string, handler: EventHandler): void {
    const list = this.eventHandlers.get(type) ?? [];
    list.push(handler);
    this.eventHandlers.set(type, list);
  }

  async start(): Promise<void> {
    await this.client.start();
  }

  async stop(): Promise<void> {
    await this.client.disconnect();
  }
}
