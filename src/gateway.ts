/**
 * WebSocket Gateway — manages the persistent connection to the signaling server.
 *
 * Handles:
 * - IDENTIFY with bot token
 * - Server-initiated heartbeat (HEARTBEAT → HEARTBEAT_ACK)
 * - Exponential backoff reconnection (1s → 30s cap, jitter)
 * - Event dispatch to typed emitter
 * - Graceful shutdown
 */

import WebSocket from 'ws';
import { Op, type WSMessage, type ReadyPayload, type Embed, type ActionRow } from './types.js';

export interface GatewayOptions {
  wsUrl: string;
  token: string;
  intents?: number;
  properties?: { os?: string; browser?: string; device?: string };
}

type DispatchHandler = (event: string, data: unknown) => void;
type LifecycleHandler = (type: 'connected' | 'disconnected' | 'reconnecting', attempt?: number) => void;
type DebugHandler = (message: string) => void;

const MAX_RECONNECT_ATTEMPTS = 20;
const MAX_RECONNECT_DELAY_MS = 30_000;

export class Gateway {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;
  private _userId: string | null = null;
  private _sessionId: string | null = null;

  private onDispatch: DispatchHandler | null = null;
  private onLifecycle: LifecycleHandler | null = null;
  private onDebug: DebugHandler | null = null;

  private readonly wsUrl: string;
  private readonly token: string;
  private readonly intents: number;
  private readonly properties: { os: string; browser: string; device: string };

  constructor(options: GatewayOptions) {
    this.wsUrl = options.wsUrl;
    this.token = options.token;
    this.intents = options.intents ?? 0;
    this.properties = {
      os: options.properties?.os ?? process.platform,
      browser: options.properties?.browser ?? 'relay-bot-sdk',
      device: options.properties?.device ?? 'server',
    };
  }

  get userId(): string | null { return this._userId; }
  get sessionId(): string | null { return this._sessionId; }
  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  /** Register handlers — called by BotClient before connect() */
  setHandlers(
    dispatch: DispatchHandler,
    lifecycle: LifecycleHandler,
    debug: DebugHandler,
  ): void {
    this.onDispatch = dispatch;
    this.onLifecycle = lifecycle;
    this.onDebug = debug;
  }

  /** Connect to the gateway. Resolves when READY is received. */
  connect(): Promise<ReadyPayload> {
    return new Promise((resolve, reject) => {
      this.intentionalDisconnect = false;
      let resolved = false;

      const onReady = (payload: ReadyPayload) => {
        if (!resolved) {
          resolved = true;
          resolve(payload);
        }
      };

      const onError = (err: Error) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      };

      this.doConnect(onReady, onError);
    });
  }

  /** Send a raw WS message. */
  send(msg: WSMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Send a voice state update. */
  sendVoiceState(action: string, channelId?: string, serverId?: string): void {
    this.send({ op: Op.VOICE_STATE, d: { action, channelId, serverId } });
  }

  /** Send an interaction response. */
  sendInteractionResponse(interactionId: string, channelId: string, content: string, ephemeral = false, embeds?: Embed[], components?: ActionRow[]): void {
    this.send({
      op: Op.INTERACTION_RESPONSE,
      d: {
        interactionId,
        type: 'message',
        channelId,
        content,
        ephemeral,
        ...(embeds?.length ? { embeds } : {}),
        ...(components?.length ? { components } : {}),
      },
    });
  }

  /** Send an interaction defer ("thinking..." indicator). */
  sendInteractionDefer(interactionId: string, channelId: string): void {
    this.send({
      op: Op.INTERACTION_DEFER,
      d: { interactionId, channelId },
    });
  }

  /** Request a PlainTransport for voice. */
  sendBotVoiceTransport(direction: 'send' | 'recv'): void {
    this.send({ op: Op.BOT_VOICE_TRANSPORT, d: { direction } });
  }

  /** Request to produce audio on the voice transport. */
  sendVoiceProduce(transportId: string, kind: 'audio', rtpParameters: unknown): void {
    this.send({
      op: Op.VOICE_PRODUCE,
      d: { transportId, kind, rtpParameters, producerType: 'mic' },
    });
  }

  /** Request to consume a producer. */
  sendVoiceConsume(producerId: string, rtpCapabilities?: unknown): void {
    this.send({
      op: Op.VOICE_CONSUME,
      d: { producerId, rtpCapabilities },
    });
  }

  /** Graceful disconnect — no reconnection. */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.close(1000, 'Bot shutting down');
      this.ws = null;
    }
    this._userId = null;
    this._sessionId = null;
  }

  // ─── Internal ────────────────────────────────────────────────────

  private doConnect(
    onFirstReady?: (payload: ReadyPayload) => void,
    onFirstError?: (err: Error) => void,
  ): void {
    this.debug(`Connecting to ${this.wsUrl}...`);

    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      this.debug('Connected, sending IDENTIFY');
      this.reconnectAttempts = 0;
      this.send({
        op: Op.IDENTIFY,
        d: {
          token: this.token,
          intents: this.intents,
          properties: this.properties,
        },
      });
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(String(raw)) as WSMessage;
        this.handleMessage(msg, onFirstReady);
      } catch (err) {
        this.debug(`Failed to parse WS message: ${err}`);
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.debug(`Disconnected: ${code} ${reason.toString()}`);
      this.ws = null;
      this.onLifecycle?.('disconnected');

      if (this.intentionalDisconnect) return;

      // Auth failure — don't reconnect
      if (code === 4003 || code === 4004) {
        onFirstError?.(new Error(`Authentication failed (code ${code})`));
        return;
      }

      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      this.debug(`WS error: ${err.message}`);
      onFirstError?.(err);
    });
  }

  private handleMessage(msg: WSMessage, onFirstReady?: (payload: ReadyPayload) => void): void {
    switch (msg.op) {
      case Op.DISPATCH: {
        const event = msg.t ?? '';
        if (event === 'READY') {
          const payload = msg.d as ReadyPayload;
          this._userId = payload.userId;
          this._sessionId = payload.sessionId;
          this.debug(`READY — userId: ${payload.userId}, servers: ${payload.serverIds.length}`);
          this.onLifecycle?.('connected');
          onFirstReady?.(payload);
        }
        this.onDispatch?.(event, msg.d);
        break;
      }

      case Op.HEARTBEAT:
        this.send({ op: Op.HEARTBEAT_ACK, d: { timestamp: Date.now() } });
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.debug(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached — giving up`);
      return;
    }

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS,
    ) + Math.random() * 1000; // jitter

    this.reconnectAttempts++;
    this.debug(`Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);
    this.onLifecycle?.('reconnecting', this.reconnectAttempts);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private debug(message: string): void {
    this.onDebug?.(`[Gateway] ${message}`);
  }
}
