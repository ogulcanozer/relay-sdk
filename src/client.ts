/**
 * BotClient — the main entry point for the Relay Bot SDK.
 *
 * Usage:
 *   const client = new BotClient({ token: 'relay_bot_...', apiUrl, wsUrl });
 *   client.on('ready', () => console.log('Connected!'));
 *   client.on('commandInteraction', interaction => { ... });
 *   await client.login();
 *
 * Provides:
 * - Typed event emitter for gateway events
 * - REST client for API calls (rate limited, retried, circuit-broken)
 * - In-memory cache populated from gateway events and REST responses
 * - Voice connection management
 * - Slash command registration and built-in /commands handler
 */

import { TypedEmitter } from './event-emitter.js';
import { Gateway } from './gateway.js';
import { RESTClient } from './rest.js';
import { Cache } from './cache.js';
import { VoiceConnection } from './voice/connection.js';
import type {
  ClientEvents,
  CommandDefinition,
  Embed,
  ActionRow,
  BotActivity,
  ReadyPayload,
  BotUser,
  CommandInteraction,
  MessagePayload,
  MessageResponse,
  ServerResponse,
  ChannelResponse,
  MemberResponse,
  RoleResponse,
  UserResponse,
  MemberJoinPayload,
  MemberLeavePayload,
  VoiceReadyPayload,
  BotVoiceTransportCreatedPayload,
  VoiceProduceReadyPayload,
  VoiceConsumerCreatedPayload,
  NewProducerPayload,
  ProducerClosedPayload,
  E2EEKeyUpdatePayload,
} from './types.js';

export interface BotClientOptions {
  /** Bot token (relay_bot_...) */
  token: string;
  /** API server URL (e.g., https://relay.insky.io) */
  apiUrl: string;
  /** WebSocket gateway URL (e.g., wss://relay.insky.io/ws) */
  wsUrl: string;
  /** Gateway intents bitmask (default: COMMAND_INTERACTIONS | VOICE_STATES) */
  intents?: number;
  /** Max retries on 5xx / network errors. Default: 3 */
  maxRetries?: number;
  /** Request timeout in ms. Default: 15000 */
  timeout?: number;
  /** Debug logger callback. Also receives gateway and cache debug messages. */
  debug?: (msg: string) => void;
}

/** Intent flags for bot event filtering. */
export const Intents = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 2,
  VOICE_STATES: 1 << 3,
  COMMAND_INTERACTIONS: 1 << 4,
} as const;

const EVENT_MAP: Record<string, keyof ClientEvents> = {
  READY: 'ready',
  COMMAND_INTERACTION: 'commandInteraction',
  MESSAGE_CREATE: 'messageCreate',
  MESSAGE_UPDATE: 'messageUpdate',
  MESSAGE_DELETE: 'messageDelete',
  VOICE_STATE_UPDATE: 'voiceStateUpdate',
  MEMBER_JOIN: 'memberJoin',
  MEMBER_LEAVE: 'memberLeave',
  VOICE_READY: 'voiceReady',
  BOT_VOICE_TRANSPORT_CREATED: 'voiceTransportCreated',
  VOICE_PRODUCE_READY: 'voiceProduceReady',
  VOICE_CONSUMER_CREATED: 'voiceConsumerCreated',
  NEW_PRODUCER: 'newProducer',
  VOICE_PRODUCER_CLOSED: 'producerClosed',
  E2EE_KEY_UPDATE: 'e2eeKeyUpdate',
  COMPONENT_INTERACTION: 'componentInteraction',
};

export class BotClient extends TypedEmitter<ClientEvents> {
  readonly rest: RESTClient;
  readonly gateway: Gateway;
  readonly cache: Cache;

  private _user: BotUser | null = null;
  private _serverIds: string[] = [];
  private _registeredCommands: CommandDefinition[] = [];
  private voice: VoiceConnection | null = null;
  private readonly debugFn: ((msg: string) => void) | null;

  constructor(options: BotClientOptions) {
    super();

    const intents = options.intents ?? (Intents.COMMAND_INTERACTIONS | Intents.VOICE_STATES);
    this.debugFn = options.debug ?? null;

    this.rest = new RESTClient({
      apiUrl: options.apiUrl,
      token: options.token,
      maxRetries: options.maxRetries,
      timeout: options.timeout,
      debug: options.debug,
    });

    this.cache = new Cache(
      this.rest,
      (msg) => this.emit('debug', msg),
    );

    this.gateway = new Gateway({
      wsUrl: options.wsUrl,
      token: options.token,
      intents,
    });

    // Wire gateway events to typed emitter
    this.gateway.setHandlers(
      (event, data) => this.handleDispatch(event, data),
      (type, attempt) => this.handleLifecycle(type, attempt),
      (msg) => this.emit('debug', msg),
    );
  }

  /** The bot's user identity (available after login). */
  get user(): BotUser | null { return this._user; }

  /** Server IDs the bot is a member of (available after login). */
  get serverIds(): string[] { return this._serverIds; }

  /** Whether the gateway is connected. */
  get connected(): boolean { return this.gateway.connected; }

  /** Current voice connection, if any. */
  get voiceConnection(): VoiceConnection | null { return this.voice; }

  // ─── Lifecycle ───────────────────────────────────────────────────

  /** Connect to the gateway. Resolves when READY is received. */
  async login(): Promise<void> {
    const ready = await this.gateway.connect();
    this._user = ready.user ?? null;
    this._serverIds = ready.serverIds;
  }

  /** Disconnect and clean up all resources. */
  async destroy(): Promise<void> {
    await this.leaveVoice();
    this.gateway.disconnect();
    this.cache.clear();
    this._user = null;
    this._serverIds = [];
    this.removeAllListeners();
  }

  // ─── Commands ────────────────────────────────────────────────────

  /** Register slash commands with the API server. Full sync — replaces all existing. Auto-appends /commands. */
  async registerCommands(commands: CommandDefinition[]): Promise<number> {
    this._registeredCommands = commands;

    // Auto-inject /commands if the bot hasn't defined it
    const hasCommands = commands.some((c) => c.name === 'commands');
    const toRegister = hasCommands
      ? commands
      : [...commands, { name: 'commands', description: 'List all commands for this bot' }];

    return this.rest.registerCommands(toRegister);
  }

  /** Reply to a command interaction. */
  reply(interaction: CommandInteraction, content: string, ephemeral?: boolean): void;
  reply(interaction: CommandInteraction, content: string, opts?: { ephemeral?: boolean; embeds?: Embed[]; components?: ActionRow[] }): void;
  reply(interaction: CommandInteraction, content: string, optsOrEphemeral?: boolean | { ephemeral?: boolean; embeds?: Embed[]; components?: ActionRow[] }): void {
    const ephemeral = typeof optsOrEphemeral === 'boolean' ? optsOrEphemeral : optsOrEphemeral?.ephemeral ?? false;
    const embeds = typeof optsOrEphemeral === 'object' ? optsOrEphemeral?.embeds : undefined;
    const components = typeof optsOrEphemeral === 'object' ? optsOrEphemeral?.components : undefined;
    this.gateway.sendInteractionResponse(
      interaction.interactionId,
      interaction.channelId,
      content,
      ephemeral,
      embeds,
      components,
    );
  }

  /** Show "thinking..." indicator for a command interaction. */
  defer(interaction: CommandInteraction): void {
    this.gateway.sendInteractionDefer(
      interaction.interactionId,
      interaction.channelId,
    );
  }

  // ─── Voice ───────────────────────────────────────────────────────

  /** Join a voice channel. Returns a VoiceConnection for audio I/O. */
  async joinVoice(channelId: string, serverId: string): Promise<VoiceConnection> {
    if (this.voice) {
      await this.leaveVoice();
    }

    this.voice = new VoiceConnection(
      this.gateway,
      this.rest,
      (msg) => this.emit('debug', `[Voice] ${msg}`),
    );

    await this.voice.join(channelId, serverId);
    return this.voice;
  }

  /** Leave the current voice channel. */
  async leaveVoice(): Promise<void> {
    if (this.voice) {
      await this.voice.leave();
      this.voice = null;
    }
  }

  // ─── Messages ────────────────────────────────────────────────────

  /** Send a message to a channel. Auto-generates nonce if not provided. */
  async sendMessage(
    channelId: string,
    content: string,
    opts?: { nonce?: string; embeds?: Embed[]; components?: ActionRow[] },
  ): Promise<MessageResponse> {
    return this.rest.sendMessage(channelId, content, opts);
  }

  /** Edit a message by ID. Pass components: null to remove all components. */
  async editMessage(messageId: string, content: string, opts?: { components?: ActionRow[] | null }): Promise<void> {
    return this.rest.editMessage(messageId, content, opts);
  }

  /** Delete a message by ID. */
  async deleteMessage(messageId: string): Promise<void> {
    return this.rest.deleteMessage(messageId);
  }

  /** Fetch messages from a channel. */
  async getMessages(
    channelId: string,
    opts?: { before?: string; limit?: number },
  ): Promise<MessageResponse[]> {
    return this.rest.listMessages(channelId, opts);
  }

  // ─── Server Info (via cache) ─────────────────────────────────────

  /** Get server info. Cached for 30 minutes. */
  async getServer(serverId: string): Promise<ServerResponse> {
    return this.cache.getServer(serverId);
  }

  /** Get all members of a server. Cached for 5 minutes. */
  async getMembers(serverId: string): Promise<MemberResponse[]> {
    return this.cache.getMembers(serverId);
  }

  /** Get all channels of a server. Cached for 30 minutes. */
  async getChannels(serverId: string): Promise<ChannelResponse[]> {
    return this.cache.getChannels(serverId);
  }

  /** Get all roles of a server. Cached for 5 minutes. */
  async getRoles(serverId: string): Promise<RoleResponse[]> {
    return this.cache.getRoles(serverId);
  }

  /** Get a user by ID. Cached for 5 minutes. */
  async getUser(userId: string): Promise<UserResponse> {
    return this.cache.getUser(userId);
  }

  // ─── Activity ───────────────────────────────────────────────────

  /** Set the bot's activity (presence). Pass null to clear. */
  async setActivity(activity: BotActivity | null): Promise<void> {
    return this.rest.updateActivity(activity);
  }

  // ─── Internal ────────────────────────────────────────────────────

  private handleDispatch(event: string, data: unknown): void {
    // Update user/server state on every READY (including reconnects)
    if (event === 'READY') {
      const payload = data as ReadyPayload;
      this._user = payload.user ?? null;
      this._serverIds = payload.serverIds;
    }

    // Track serverIds on mid-session membership changes
    if (event === 'MEMBER_JOIN') {
      const payload = data as MemberJoinPayload;
      if (payload.user?.id === this._user?.id && !this._serverIds.includes(payload.serverId)) {
        this._serverIds.push(payload.serverId);
      }
      this.cache.handleMemberJoin(payload);
    }
    if (event === 'MEMBER_LEAVE') {
      const payload = data as MemberLeavePayload;
      if (payload.userId === this._user?.id) {
        this._serverIds = this._serverIds.filter(id => id !== payload.serverId);
      }
      this.cache.handleMemberLeave(payload);
    }

    // Populate cache from gateway events
    if (event === 'MESSAGE_CREATE') {
      this.cache.handleMessageCreate(data as MessagePayload);
    }
    if (event === 'PRESENCE_UPDATE') {
      const payload = data as { userId: string; status: string };
      this.cache.handlePresenceUpdate(payload);
    }

    // Route voice events to VoiceConnection
    if (this.voice) {
      switch (event) {
        case 'VOICE_READY':
          this.voice.handleVoiceReady(data as VoiceReadyPayload);
          break;
        case 'BOT_VOICE_TRANSPORT_CREATED':
          this.voice.handleTransportCreated(data as BotVoiceTransportCreatedPayload);
          break;
        case 'VOICE_PRODUCE_READY':
          this.voice.handleProduceReady(data as VoiceProduceReadyPayload);
          break;
        case 'VOICE_CONSUMER_CREATED':
          this.voice.handleConsumerCreated(data as VoiceConsumerCreatedPayload);
          break;
        case 'NEW_PRODUCER':
          this.voice.handleNewProducer(data as NewProducerPayload);
          break;
        case 'VOICE_PRODUCER_CLOSED':
          this.voice.handleProducerClosed(data as ProducerClosedPayload);
          break;
        case 'E2EE_KEY_UPDATE':
          this.voice.handleE2EEKeyUpdate(data as E2EEKeyUpdatePayload);
          break;
      }
    }

    // Intercept built-in /commands before emitting to user handlers
    if (event === 'COMMAND_INTERACTION') {
      const interaction = data as CommandInteraction;
      if (interaction.commandName === 'commands' && !this._registeredCommands.some((c) => c.name === 'commands')) {
        this.handleBuiltinCommands(interaction);
        return;
      }
    }

    // Emit typed events
    const mapped = EVENT_MAP[event];
    if (mapped) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.emit(mapped, data as any);
    }
  }

  private handleBuiltinCommands(interaction: CommandInteraction): void {
    const cmds = this._registeredCommands;
    if (cmds.length === 0) {
      this.reply(interaction, 'This bot has no commands registered.');
      return;
    }

    const botName = this._user?.displayName ?? this._user?.username ?? 'Bot';
    const lines: string[] = [`**${botName} Commands**`, ''];

    for (const cmd of cmds) {
      const params = (cmd.parameters ?? [])
        .map((p) => (p.required !== false ? `<${p.name}>` : `[${p.name}]`))
        .join(' ');

      const access = cmd.defaultAccess === 'admin_only' ? ' `admin`' : '';
      const cooldown = cmd.cooldownSeconds ? ` \`${cmd.cooldownSeconds}s cd\`` : '';

      lines.push(`\`/${cmd.name}\`${params ? ' ' + params : ''} — ${cmd.description}${access}${cooldown}`);
    }

    this.reply(interaction, lines.join('\n'));
  }

  private handleLifecycle(type: 'connected' | 'disconnected' | 'reconnecting', attempt?: number): void {
    switch (type) {
      case 'connected':
        this.emit('connected');
        break;
      case 'disconnected':
        this.emit('disconnected');
        break;
      case 'reconnecting':
        this.emit('reconnecting', attempt ?? 0);
        break;
    }
  }
}
