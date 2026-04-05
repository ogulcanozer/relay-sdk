/**
 * BotClient — the main entry point for the Relay Bot SDK.
 *
 * Usage:
 *   const client = new BotClient({ token: 'relay_bot_...', apiUrl, wsUrl });
 *   client.on('ready', () => console.log('Connected!'));
 *   client.on('commandInteraction', interaction => { ... });
 *   await client.login();
 *
 * Clean API surface — full SDK expansion (caching, command framework,
 * rate limits, sharding) is purely additive.
 */

import { TypedEmitter } from './event-emitter.js';
import { Gateway } from './gateway.js';
import { RESTClient } from './rest.js';
import { VoiceConnection } from './voice/connection.js';
import type {
  ClientEvents,
  CommandDefinition,
  ReadyPayload,
  BotUser,
  CommandInteraction,
  MessagePayload,
  VoiceStateUpdatePayload,
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
};

export class BotClient extends TypedEmitter<ClientEvents> {
  readonly rest: RESTClient;
  readonly gateway: Gateway;

  private _user: BotUser | null = null;
  private _serverIds: string[] = [];
  private voice: VoiceConnection | null = null;

  constructor(options: BotClientOptions) {
    super();

    const intents = options.intents ?? (Intents.COMMAND_INTERACTIONS | Intents.VOICE_STATES);

    this.rest = new RESTClient({
      apiUrl: options.apiUrl,
      token: options.token,
    });

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
    this._user = null;
    this._serverIds = [];
    this.removeAllListeners();
  }

  // ─── Commands ────────────────────────────────────────────────────

  /** Register slash commands with the API server. Full sync — replaces all existing. */
  async registerCommands(commands: CommandDefinition[]): Promise<number> {
    return this.rest.registerCommands(commands);
  }

  /** Reply to a command interaction. */
  reply(interaction: CommandInteraction, content: string, ephemeral = false): void {
    this.gateway.sendInteractionResponse(
      interaction.interactionId,
      interaction.channelId,
      content,
      ephemeral,
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

  /** Send a message to a server channel. */
  async sendMessage(channelId: string, serverId: string, content: string): Promise<unknown> {
    return this.rest.sendMessage(channelId, serverId, content);
  }

  // ─── Internal ────────────────────────────────────────────────────

  private handleDispatch(event: string, data: unknown): void {
    // Update user/server state on every READY (including reconnects)
    if (event === 'READY') {
      const payload = data as ReadyPayload;
      this._user = payload.user ?? null;
      this._serverIds = payload.serverIds;
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

    // Emit typed events
    const mapped = EVENT_MAP[event];
    if (mapped) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.emit(mapped, data as any);
    }
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
