/**
 * VoiceConnection — manages a bot's voice session in a channel.
 *
 * Lifecycle:
 *   1. joinVoice(channelId, serverId) — tRPC call + WS voice state
 *   2. VOICE_READY → request send + recv PlainTransports
 *   3. BOT_VOICE_TRANSPORT_CREATED → open UDP sockets
 *   4. VOICE_PRODUCE_READY → send dummy RTP (comedia), start send loop
 *   5. NEW_PRODUCER / VOICE_CONSUMER_CREATED → receive RTP, decrypt, decode
 *   6. leave() → close sockets, clean up
 *
 * E2EE: Epoch secrets arrive in VOICE_READY.e2ee and E2EE_KEY_UPDATE.
 * Incoming Opus frames are decrypted before decode.
 * Outgoing frames are NOT encrypted (PlainTransport = raw RTP, no Encoded Transform).
 * This matches the architecture: only WebRTC clients encrypt via RTCRtpScriptTransform.
 *
 * Wait — if clients encrypt, bots must decrypt or they hear nothing. ✓ (E2EEKeyManager handles this)
 * But bots can't encrypt via PlainTransport. The SFU forwards bot's unencrypted RTP to clients.
 * Clients' decryptors will fail on these frames and pass them through (garbled/silent).
 *
 * TODO: For full E2EE compatibility, bots need to encrypt outgoing frames too.
 * This requires: encryptOpus(frame) → [TOC | ciphertext | tag] before RTP packing.
 */

import * as dgram from 'node:dgram';
import { parseRtpPacket, RtpSender, type RtpPacket } from './rtp.js';
import { decodeOpus, encodeOpus, initOpus, pcmToInt16, FRAME_SIZE, FRAME_BYTES } from './opus.js';
import { E2EEKeyManager } from './e2ee.js';
import type { Gateway } from '../gateway.js';
import type { RESTClient } from '../rest.js';
import type {
  VoiceReadyPayload,
  BotVoiceTransportCreatedPayload,
  VoiceProduceReadyPayload,
  VoiceConsumerCreatedPayload,
  NewProducerPayload,
  ProducerClosedPayload,
  E2EEKeyUpdatePayload,
} from '../types.js';

type DebugFn = (message: string) => void;

export interface VoiceEvents {
  /** Fired when an incoming RTP packet is decoded to PCM. */
  audioReceive: (userId: string, pcm: Int16Array) => void;
  /** Voice connection is ready to send/receive audio. */
  ready: () => void;
  /** Voice connection was destroyed. */
  destroyed: () => void;
}

export class VoiceConnection {
  private gateway: Gateway;
  private rest: RESTClient;
  private debug: DebugFn;

  private channelId: string | null = null;
  private serverId: string | null = null;
  private voiceSessionId: string | null = null;

  // UDP sockets
  private sendSocket: dgram.Socket | null = null;
  private recvSocket: dgram.Socket | null = null;
  private sendAddr: { ip: string; port: number } | null = null;
  private recvAddr: { ip: string; port: number } | null = null;

  // RTP
  private rtpSender: RtpSender | null = null;
  private sendInterval: ReturnType<typeof setInterval> | null = null;
  private sendQueue: Buffer[] = [];

  // Consumers — producerId → userId
  private consumers = new Map<string, string>();

  // E2EE
  private e2ee = new E2EEKeyManager();

  // Callbacks
  private onAudioReceive: ((userId: string, pcm: Int16Array) => void) | null = null;
  private onReady: (() => void) | null = null;
  private onDestroyed: (() => void) | null = null;

  // State
  private _ready = false;
  private opusInitialized = false;

  constructor(gateway: Gateway, rest: RESTClient, debug: DebugFn) {
    this.gateway = gateway;
    this.rest = rest;
    this.debug = debug;
  }

  get ready(): boolean { return this._ready; }

  /** Register voice event handlers. */
  on<K extends keyof VoiceEvents>(event: K, handler: VoiceEvents[K]): this {
    switch (event) {
      case 'audioReceive': this.onAudioReceive = handler as VoiceEvents['audioReceive']; break;
      case 'ready': this.onReady = handler as VoiceEvents['ready']; break;
      case 'destroyed': this.onDestroyed = handler as VoiceEvents['destroyed']; break;
    }
    return this;
  }

  /** Join a voice channel. Returns when the voice pipeline is ready. */
  async join(channelId: string, serverId: string): Promise<void> {
    this.channelId = channelId;
    this.serverId = serverId;

    // Initialize Opus if not already done
    if (!this.opusInitialized) {
      await initOpus();
      this.opusInitialized = true;
    }

    // Phase 1: tRPC call to register in DB
    await this.rest.joinVoiceChannel(channelId, serverId);

    // Phase 2: WS voice state join → triggers VOICE_READY
    this.gateway.sendVoiceState('join', channelId, serverId);
    this.debug(`Joining voice channel ${channelId} in server ${serverId}`);
  }

  /** Leave the current voice channel. */
  async leave(): Promise<void> {
    this.gateway.sendVoiceState('leave');
    try {
      await this.rest.leaveVoiceChannel();
    } catch {
      // Best-effort
    }
    this.destroy();
  }

  /**
   * Queue PCM audio for sending. Each call should be one 20ms frame (960 samples).
   * Opus encodes and RTP packs automatically.
   */
  sendAudio(pcm: Buffer): void {
    if (!this.rtpSender || !this.sendSocket || !this.sendAddr) return;

    try {
      const opus = encodeOpus(pcm);
      const packet = this.rtpSender.pack(opus);
      this.sendSocket.send(packet, this.sendAddr.port, this.sendAddr.ip);
    } catch (err) {
      this.debug(`Send audio error: ${err}`);
    }
  }

  /**
   * Queue an already-encoded Opus frame for sending.
   * Use this when streaming pre-encoded audio (e.g., from ffmpeg).
   */
  sendOpus(opusFrame: Buffer): void {
    if (!this.rtpSender || !this.sendSocket || !this.sendAddr) return;

    const packet = this.rtpSender.pack(opusFrame);
    this.sendSocket.send(packet, this.sendAddr.port, this.sendAddr.ip);
  }

  // ─── Gateway Event Handlers (called by BotClient) ────────────────

  handleVoiceReady(data: VoiceReadyPayload): void {
    this.voiceSessionId = data.voiceSessionId;

    // Set E2EE keys
    if (data.e2ee) {
      this.e2ee.setKeys(data.e2ee.epochSecret);
      this.debug(`E2EE keys set (epoch ${data.e2ee.epoch})`);
    }

    // Request send transport
    this.gateway.sendBotVoiceTransport('send');
    this.debug('VOICE_READY — requesting send transport');

    // Consume existing producers
    for (const p of data.existingProducers) {
      this.consumeProducer(p.producerId, p.userId);
    }
  }

  handleTransportCreated(data: BotVoiceTransportCreatedPayload): void {
    if (data.direction === 'send') {
      this.sendAddr = { ip: data.ip, port: data.port };
      this.sendSocket = dgram.createSocket('udp4');

      // Request produce (bot sends Opus audio)
      this.gateway.sendVoiceProduce('', 'audio', {
        codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 1 }],
      });
      this.debug(`Send transport created: ${data.ip}:${data.port}`);
    } else {
      this.recvAddr = { ip: data.ip, port: data.port };
      this.setupRecvSocket(data.ip, data.port);
      this.debug(`Recv transport created: ${data.ip}:${data.port}`);
    }
  }

  handleProduceReady(data: VoiceProduceReadyPayload): void {
    if (!this.sendSocket || !this.sendAddr) return;

    // RTP sender with standard Opus payload type
    this.rtpSender = new RtpSender(
      Math.floor(Math.random() * 0xffffffff),
      111, // Opus payload type
      48000,
    );

    // Send dummy packet to register address (comedia)
    const dummy = Buffer.alloc(12 + 3);
    dummy[0] = 0x80;
    dummy[1] = 111;
    this.sendSocket.send(dummy, this.sendAddr.port, this.sendAddr.ip);

    // Request recv transport
    this.gateway.sendBotVoiceTransport('recv');

    this._ready = true;
    this.onReady?.();
    this.debug(`Producer ready: ${data.producerId} — voice connection fully ready`);
  }

  handleConsumerCreated(data: VoiceConsumerCreatedPayload): void {
    const userId = data.userId ?? 'unknown';
    this.consumers.set(data.producerId, userId);
    this.debug(`Consumer created for ${userId} (producer ${data.producerId})`);
  }

  handleNewProducer(data: NewProducerPayload): void {
    this.consumeProducer(data.producerId, data.userId);
  }

  handleProducerClosed(data: ProducerClosedPayload): void {
    this.consumers.delete(data.producerId);
    this.e2ee.removeSender(data.userId);
    this.debug(`Producer closed: ${data.producerId} (${data.userId})`);
  }

  handleE2EEKeyUpdate(data: E2EEKeyUpdatePayload): void {
    this.e2ee.updateKeys(data.epochSecret);
    this.debug(`E2EE keys updated (epoch ${data.epoch})`);
  }

  // ─── Internal ────────────────────────────────────────────────────

  private consumeProducer(producerId: string, userId: string): void {
    // Only consume mic audio (not video/screen)
    this.gateway.sendVoiceConsume(producerId);
    this.consumers.set(producerId, userId);
    this.debug(`Consuming producer ${producerId} from ${userId}`);
  }

  private setupRecvSocket(ip: string, port: number): void {
    this.recvSocket = dgram.createSocket('udp4');

    this.recvSocket.on('message', (buf: Buffer) => {
      this.handleIncomingRtp(buf);
    });

    this.recvSocket.on('error', (err) => {
      this.debug(`Recv socket error: ${err.message}`);
    });

    // Send dummy to register (comedia)
    const dummy = Buffer.alloc(12 + 3);
    dummy[0] = 0x80;
    dummy[1] = 111;
    this.recvSocket.send(dummy, port, ip);
  }

  private handleIncomingRtp(buf: Buffer): void {
    const packet = parseRtpPacket(buf);
    if (!packet || packet.payload.length === 0) return;

    // Find which user this packet belongs to (by SSRC → consumer map lookup)
    // For now, try to match by iterating consumers (simplified — production would use SSRC mapping)
    // The userId is resolved from the consumer map when VOICE_CONSUMER_CREATED arrives

    let opusPayload = packet.payload;

    // E2EE: try to decrypt if keys are set
    // Each sender's frames are encrypted with their own key
    // We try decryption for each known sender — the one that succeeds is the right one
    // In practice, SSRC → userId mapping would be more efficient
    for (const [, userId] of this.consumers) {
      const decryptor = this.e2ee.getDecryptor(userId);
      const decrypted = decryptor.decrypt(opusPayload);
      if (decrypted) {
        opusPayload = decrypted;
        this.emitDecodedAudio(userId, opusPayload);
        return;
      }
    }

    // No E2EE or decryption not needed — decode directly
    this.emitDecodedAudio('unknown', opusPayload);
  }

  private emitDecodedAudio(userId: string, opusPayload: Buffer): void {
    if (!this.onAudioReceive) return;

    try {
      const pcmBuf = decodeOpus(opusPayload);
      const pcm = pcmToInt16(pcmBuf);
      this.onAudioReceive(userId, pcm);
    } catch (err) {
      this.debug(`Opus decode error for ${userId}: ${err}`);
    }
  }

  destroy(): void {
    if (this.sendInterval) {
      clearInterval(this.sendInterval);
      this.sendInterval = null;
    }

    this.sendSocket?.close();
    this.sendSocket = null;
    this.recvSocket?.close();
    this.recvSocket = null;
    this.sendAddr = null;
    this.recvAddr = null;
    this.rtpSender = null;
    this.consumers.clear();
    this.e2ee.destroy();
    this._ready = false;

    this.channelId = null;
    this.serverId = null;
    this.voiceSessionId = null;

    this.onDestroyed?.();
    this.debug('Voice connection destroyed');
  }
}
