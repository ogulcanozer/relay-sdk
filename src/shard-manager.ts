/**
 * ShardManager — manages multiple BotClient instances for horizontal scaling.
 *
 * Distributes servers across N shards using `serverId % totalShards`.
 * Each shard is a separate gateway connection. Events are filtered
 * client-side — each shard only processes events for its servers.
 *
 * Usage:
 *   const manager = new ShardManager({
 *     token: 'relay_bot_...',
 *     apiUrl: 'https://relay.insky.io',
 *     wsUrl: 'wss://relay.insky.io/ws',
 *     totalShards: 2,
 *   });
 *
 *   manager.on('commandInteraction', (interaction, shardId) => { ... });
 *   manager.on('componentInteraction', (interaction, shardId) => { ... });
 *   await manager.login();
 *
 * For small bots (< 1000 servers), use BotClient directly — no sharding needed.
 */

import { BotClient, type BotClientOptions } from './client.js';
import type {
  ClientEvents,
  CommandInteraction,
  ComponentInteraction,
  MemberJoinPayload,
  MemberLeavePayload,
  MessagePayload,
  BotUser,
} from './types.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface ShardManagerOptions extends Omit<BotClientOptions, 'intents'> {
  /** Total number of shards. */
  totalShards: number;
  /** Gateway intents bitmask. Applied to all shards. */
  intents?: number;
}

type ShardEventHandler<K extends keyof ClientEvents> = (
  ...args: [...ClientEvents[K], shardId: number]
) => void;

interface ShardManagerEvents {
  ready: (shardId: number) => void;
  allReady: () => void;
  commandInteraction: ShardEventHandler<'commandInteraction'>;
  componentInteraction: ShardEventHandler<'componentInteraction'>;
  messageCreate: ShardEventHandler<'messageCreate'>;
  messageUpdate: ShardEventHandler<'messageUpdate'>;
  messageDelete: ShardEventHandler<'messageDelete'>;
  memberJoin: ShardEventHandler<'memberJoin'>;
  memberLeave: ShardEventHandler<'memberLeave'>;
  error: (error: Error, shardId: number) => void;
  shardDisconnected: (shardId: number) => void;
  shardReconnecting: (shardId: number, attempt: number) => void;
}

// ─── Shard Assignment ───────────────────────────────────────────────

/** Determine which shard owns a server. */
function shardForServer(serverId: string, totalShards: number): number {
  // Use last few digits to avoid BigInt for simple modulo
  // Works for snowflake IDs since they're sequential-ish
  const numericTail = Number(serverId.slice(-10)) || 0;
  return numericTail % totalShards;
}

// ─── ShardManager ───────────────────────────────────────────────────

export class ShardManager {
  readonly totalShards: number;
  private readonly shards: BotClient[] = [];
  private readonly shardServerMap = new Map<number, Set<string>>();
  private readonly options: BotClientOptions;
  private readonly handlers = new Map<string, Function[]>();
  private readyCount = 0;

  constructor(options: ShardManagerOptions) {
    this.totalShards = options.totalShards;
    this.options = {
      token: options.token,
      apiUrl: options.apiUrl,
      wsUrl: options.wsUrl,
      intents: options.intents,
      maxRetries: options.maxRetries,
      timeout: options.timeout,
      debug: options.debug,
    };

    for (let i = 0; i < this.totalShards; i++) {
      const shard = new BotClient(this.options);
      this.shards.push(shard);
      this.shardServerMap.set(i, new Set());
      this.wireShard(shard, i);
    }
  }

  /** The bot's user identity (from shard 0). */
  get user(): BotUser | null {
    return this.shards[0]?.user ?? null;
  }

  /** All server IDs across all shards. */
  get serverIds(): string[] {
    const ids: string[] = [];
    for (const set of this.shardServerMap.values()) {
      ids.push(...set);
    }
    return ids;
  }

  /** Get a specific shard's BotClient. */
  getShard(shardId: number): BotClient | undefined {
    return this.shards[shardId];
  }

  /** Get the shard that handles a specific server. */
  shardFor(serverId: string): BotClient {
    const id = shardForServer(serverId, this.totalShards);
    return this.shards[id]!;
  }

  /** Connect all shards. Resolves when all are READY. */
  async login(): Promise<void> {
    // Stagger shard connections by 5 seconds to avoid rate limits
    for (let i = 0; i < this.shards.length; i++) {
      if (i > 0) await sleep(5000);
      await this.shards[i]!.login();
      // Build server map from the shard's server list
      const serverIds = this.shards[i]!.serverIds;
      const set = this.shardServerMap.get(i)!;
      for (const id of serverIds) {
        set.add(id);
      }
    }
  }

  /** Register commands on shard 0 (commands are global, not per-shard). */
  async registerCommands(commands: import('./types.js').CommandDefinition[]): Promise<number> {
    return this.shards[0]!.registerCommands(commands);
  }

  /** Set activity on all shards. */
  async setActivity(activity: import('./types.js').BotActivity | null): Promise<void> {
    await Promise.all(this.shards.map((s) => s.setActivity(activity)));
  }

  /** Disconnect all shards. */
  async destroy(): Promise<void> {
    await Promise.all(this.shards.map((s) => s.destroy()));
  }

  /** Register an event handler. */
  on<K extends keyof ShardManagerEvents>(event: K, handler: ShardManagerEvents[K]): this {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(handler);
    return this;
  }

  private emit(event: string, ...args: unknown[]): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const h of handlers) h(...args);
    }
  }

  private wireShard(shard: BotClient, shardId: number): void {
    shard.on('ready', () => {
      this.readyCount++;
      this.emit('ready', shardId);
      if (this.readyCount === this.totalShards) {
        this.emit('allReady');
      }
    });

    shard.on('commandInteraction', (interaction: CommandInteraction) => {
      // Route to owning shard only
      if (shardForServer(interaction.serverId, this.totalShards) === shardId) {
        this.emit('commandInteraction', interaction, shardId);
      }
    });

    shard.on('componentInteraction', (interaction: ComponentInteraction) => {
      if (interaction.serverId && shardForServer(interaction.serverId, this.totalShards) === shardId) {
        this.emit('componentInteraction', interaction, shardId);
      } else if (!interaction.serverId) {
        // No serverId — route to shard 0 as fallback
        if (shardId === 0) this.emit('componentInteraction', interaction, shardId);
      }
    });

    shard.on('messageCreate', (message: MessagePayload) => {
      if (message.serverId && shardForServer(message.serverId, this.totalShards) === shardId) {
        this.emit('messageCreate', message, shardId);
      }
    });

    shard.on('messageUpdate', (message: MessagePayload) => {
      if (message.serverId && shardForServer(message.serverId, this.totalShards) === shardId) {
        this.emit('messageUpdate', message, shardId);
      }
    });

    shard.on('memberJoin', (payload: MemberJoinPayload) => {
      if (shardForServer(payload.serverId, this.totalShards) === shardId) {
        this.shardServerMap.get(shardId)?.add(payload.serverId);
        this.emit('memberJoin', payload, shardId);
      }
    });

    shard.on('memberLeave', (payload: MemberLeavePayload) => {
      if (shardForServer(payload.serverId, this.totalShards) === shardId) {
        this.shardServerMap.get(shardId)?.delete(payload.serverId);
        this.emit('memberLeave', payload, shardId);
      }
    });

    shard.on('error', (err: Error) => {
      this.emit('error', err, shardId);
    });

    shard.on('disconnected', () => {
      this.emit('shardDisconnected', shardId);
    });

    shard.on('reconnecting', (attempt: number) => {
      this.emit('shardReconnecting', shardId, attempt);
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
