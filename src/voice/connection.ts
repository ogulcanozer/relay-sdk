/**
 * VoiceConnection — manages a bot's voice session against the Relay
 * Rust signaling server.
 *
 * The wire contract lives in the Rust crate
 * `crates/signaling-server/src/media/voice_handler.rs`. Every decision in
 * this file flows from a strict reading of that file plus the mediasoup
 * router configuration at `crates/signaling-server/src/media/workers.rs`.
 *
 * ## The handshake, in order
 *
 * The Rust server imposes a strict ordering on bot voice setup. Each step
 * MUST complete before the next begins or the room state machine rejects
 * the request (or, worse, silently drops it).
 *
 *   ┌─ client ─────────────────────────┬─ server ─────────────────────┐
 *   │                                   │                              │
 *   │ 1. REST joinVoiceChannel          │                              │
 *   │ 2. WS VOICE_STATE {action:'join'} │                              │
 *   │                                   │ ↪ creates room membership,  │
 *   │                                   │   rotates E2EE epoch,        │
 *   │                                   │   dispatches VOICE_READY     │
 *   │                                   │                              │
 *   │ 3. cache routerRtpCapabilities,   │                              │
 *   │    E2EE keys, existingProducers.  │                              │
 *   │    WS BOT_VOICE_TRANSPORT {send}  │                              │
 *   │                                   │ ↪ creates PlainTransport    │
 *   │                                   │   (comedia=true), dispatches │
 *   │                                   │   BOT_VOICE_TRANSPORT_CREATED│
 *   │                                   │                              │
 *   │ 4. open send UDP socket,          │                              │
 *   │    generate SSRC,                 │                              │
 *   │    WS VOICE_PRODUCE {...}         │                              │
 *   │                                   │ ↪ creates mediasoup Producer,│
 *   │                                   │   dispatches                 │
 *   │                                   │   VOICE_PRODUCE_READY +      │
 *   │                                   │   fans NEW_PRODUCER to room  │
 *   │                                   │                              │
 *   │ 5. create RtpSender,              │                              │
 *   │    punch NAT (comedia),           │                              │
 *   │    WS BOT_VOICE_TRANSPORT {recv}  │                              │
 *   │                                   │ ↪ creates recv PlainTransport│
 *   │                                   │   dispatches                 │
 *   │                                   │   BOT_VOICE_TRANSPORT_CREATED│
 *   │                                   │                              │
 *   │ 6. open recv UDP socket,          │                              │
 *   │    punch NAT, mark ready,         │                              │
 *   │    drain existingProducers queue, │                              │
 *   │    WS VOICE_CONSUME {...} for each│                              │
 *   │                                   │ ↪ creates mediasoup Consumers│
 *   │                                   │   dispatches                 │
 *   │                                   │   VOICE_CONSUMER_CREATED each│
 *   └───────────────────────────────────┴──────────────────────────────┘
 *
 * ## Why the order matters
 *
 * - **recv transport must exist before VOICE_CONSUME.** Rust's
 *   `handle_voice_consume` at voice_handler.rs:1259 bails with
 *   `"no recv transport for consume"` when the recv transport is `None`.
 *   Consuming the `existingProducers` list from VOICE_READY before the
 *   recv transport is ready floods the log and produces no audio.
 *
 * - **SSRC must match.** Rust's mediasoup matches producer's
 *   `rtpParameters.encodings[0].ssrc` against the actual RTP stream's
 *   header SSRC. They're generated once up-front in step 4 and shared
 *   with the RtpSender in step 5.
 *
 * - **Codec must be Opus@2ch.** The router at `workers.rs:240` declares
 *   Opus with `channels: 2`. `mediasoup-0.20.0/src/ortc.rs:1055` rejects
 *   any producer whose codec channels differ. See `opus.ts` — the bot
 *   encodes stereo end-to-end.
 *
 * ## E2EE
 *
 * Incoming RTP frames are decrypted via per-sender AES-128-GCM keys
 * derived from the epoch secret the server sends in VOICE_READY.e2ee /
 * E2EE_KEY_UPDATE. See `e2ee.ts`.
 *
 * Outgoing frames are NOT encrypted. PlainTransport skips RTCRtpScriptTransform
 * so there is no Encoded Transform path on the bot side. The SFU forwards
 * the bot's cleartext Opus frames to browser consumers. Browser clients
 * will attempt to decrypt them, fail, and pass them through their
 * decryptor (see `packages/client/src/lib/audio/e2ee-manager.ts`). This
 * matches how the Node bot SDK behaved — a known limitation tracked for
 * a future SDK release.
 *
 * ## SSRC → userId routing
 *
 * When a VOICE_CONSUMER_CREATED dispatch arrives the bot records the
 * consumer's SSRC (from `rtpParameters.encodings[0].ssrc`) alongside the
 * producer's `userId`. Incoming RTP packets are routed directly by SSRC —
 * no per-packet scan over every known sender's decryptor.
 */

import * as dgram from 'node:dgram';
import { parseRtpPacket, RtpSender } from './rtp.js';
import { decodeOpus, encodeOpus, initOpus, pcmToInt16 } from './opus.js';
import { E2EEKeyManager, E2EEEncryptor } from './e2ee.js';
import type { Gateway } from '../gateway.js';
import type { RESTClient } from '../rest.js';

/**
 * Maximum E2EE protocol version THIS SDK supports. Bumped in lockstep
 * with the `E2EEEncryptor` implementation here — current v1 is the
 * AES-128-GCM frame encryption with HKDF-derived per-sender keys,
 * matching the web client. Declared on every voice join so the server
 * can negotiate `min(participants)` across the room.
 *
 * Kept as a local const rather than importing from `@relay/shared`
 * because this SDK is a separately-published package and mustn't
 * take a workspace-peer dependency on the main client's shared
 * constants crate. If the numbering drifts between the two, the
 * `V0_TRANSPORT_ONLY` / `V1_FRAME` comment in
 * `crates/signaling-server/src/e2ee/protocol.rs` is the canonical
 * reference.
 */
const E2EE_PROTOCOL_VERSION = 1;
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

/**
 * Lifecycle states of the voice connection. Every handler asserts on the
 * current state and transitions it atomically. This mirrors how the Rust
 * side tracks the room's per-participant state machine.
 */
type State =
  | 'idle' // no join() in flight
  | 'joining' // sent VOICE_STATE join, waiting for VOICE_READY
  | 'readySentXportReq' // got VOICE_READY, requested send transport
  | 'sendXportReady' // got send transport, sent VOICE_PRODUCE
  | 'producing' // got VOICE_PRODUCE_READY, requested recv transport
  | 'ready' // got recv transport — full duplex audio active
  | 'leaving'; // in destroy()

export interface VoiceEvents {
  /** Fired when an incoming RTP packet is decoded to PCM. */
  audioReceive: (userId: string, pcm: Int16Array) => void;
  /** Voice connection is ready to send/receive audio. */
  ready: () => void;
  /** Voice connection was destroyed. */
  destroyed: () => void;
}

/** Opus RTP payload type for our router — must match workers.rs `preferred_payload_type: Some(111)`. */
const OPUS_PAYLOAD_TYPE = 111;
/** Opus RTP clock rate — must match workers.rs `clock_rate: 48000`. */
const OPUS_CLOCK_RATE = 48000;
/** Opus channels — must match workers.rs `channels: 2`. */
const OPUS_CHANNELS = 2;

export class VoiceConnection {
  private gateway: Gateway;
  private rest: RESTClient;
  private debug: DebugFn;

  // ─── Lifecycle ──────────────────────────────────────────────────
  private state: State = 'idle';
  private channelId: string | null = null;
  private serverId: string | null = null;
  private voiceSessionId: string | null = null;

  /**
   * Router RtpCapabilities captured from VOICE_READY and echoed back on
   * every VOICE_CONSUME. The server's `router.can_consume(...)` check
   * does strict ORTC matching, so sending the router's own capabilities
   * is the universal "accept anything" value — we don't need to build a
   * bot-specific subset.
   */
  private routerRtpCapabilities: unknown = null;

  // ─── Produce (send) path ────────────────────────────────────────
  private sendSocket: dgram.Socket | null = null;
  private sendAddr: { ip: string; port: number } | null = null;
  private sendTransportId: string | null = null;
  /**
   * The SSRC declared in `rtpParameters.encodings[0].ssrc` and reused
   * verbatim by the outbound RtpSender. Must be generated once before
   * VOICE_PRODUCE and held stable for the entire producing session.
   */
  private sendSsrc: number | null = null;
  private rtpSender: RtpSender | null = null;

  // ─── Consume (recv) path ────────────────────────────────────────
  private recvSocket: dgram.Socket | null = null;
  private recvAddr: { ip: string; port: number } | null = null;
  private recvTransportId: string | null = null;

  /**
   * Producers discovered in VOICE_READY.existingProducers before the recv
   * transport is ready. Consuming them any earlier would trip Rust's
   * `no recv transport for consume` guard in voice_handler.rs:1263.
   * Flushed once inside `handleTransportCreated('recv', …)`.
   */
  private pendingProducers: Array<{ producerId: string; userId: string }> = [];

  /**
   * Producers that have been asked to consume but haven't yet gotten a
   * VOICE_CONSUMER_CREATED dispatch back. Used only for debug clarity —
   * the authoritative SSRC→userId mapping is `ssrcToUser` below.
   */
  private pendingConsumes = new Map<string, string>(); // producerId → userId

  /**
   * SSRC → userId index, populated on VOICE_CONSUMER_CREATED from the
   * consumer's `rtpParameters.encodings[0].ssrc`. Used to route incoming
   * RTP packets to the correct E2EE decryptor in O(1).
   */
  private ssrcToUser = new Map<number, string>();

  /**
   * producerId → SSRC back-index so we can clean up `ssrcToUser` when
   * PRODUCER_CLOSED arrives (payload carries producerId, not ssrc).
   */
  private producerToSsrc = new Map<string, number>();

  /** E2EE decryptor pool (one per sender userId). */
  private e2ee = new E2EEKeyManager();

  /** E2EE encryptor for outgoing Opus frames. Initialized when keys
   *  arrive via VOICE_READY. Without this, bot-produced frames go on
   *  the wire cleartext and browser clients' decryptors fail-then-
   *  passthrough — audible but not confidential. */
  private encryptor: E2EEEncryptor | null = null;

  /**
   * Current speaking state, driven by [`setSpeaking`]. Survives WS
   * reconnects so [`handleVoiceReady`] can re-emit the op when a new
   * voice session starts — without this, a bot that was mid-track
   * when the WS dropped would have a permanently-dark speaking ring
   * on every browser client until the next pause/resume/stop call,
   * which could be the entire length of the current song. See
   * Phase 7 of `docs/audit/2026-04-09-audio-voice-race-audit.md`.
   */
  private speakingState = false;

  // ─── Callbacks ──────────────────────────────────────────────────
  private onAudioReceive: ((userId: string, pcm: Int16Array) => void) | null = null;
  private onReady: (() => void) | null = null;
  private onDestroyed: (() => void) | null = null;

  // ─── One-time init flags ────────────────────────────────────────
  private opusInitialized = false;

  constructor(gateway: Gateway, rest: RESTClient, debug: DebugFn) {
    this.gateway = gateway;
    this.rest = rest;
    this.debug = debug;
  }

  get ready(): boolean {
    return this.state === 'ready';
  }

  /** Register voice event handlers. */
  on<K extends keyof VoiceEvents>(event: K, handler: VoiceEvents[K]): this {
    switch (event) {
      case 'audioReceive':
        this.onAudioReceive = handler as VoiceEvents['audioReceive'];
        break;
      case 'ready':
        this.onReady = handler as VoiceEvents['ready'];
        break;
      case 'destroyed':
        this.onDestroyed = handler as VoiceEvents['destroyed'];
        break;
    }
    return this;
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Join a voice channel. Resolves once the REST call + WS join frame
   * have been sent — the full voice pipeline readiness is signalled later
   * via the `ready` event.
   */
  async join(channelId: string, serverId: string): Promise<void> {
    if (this.state !== 'idle') {
      this.debug(`join() called in state ${this.state} — ignoring`);
      return;
    }

    this.channelId = channelId;
    this.serverId = serverId;
    this.state = 'joining';

    if (!this.opusInitialized) {
      await initOpus();
      this.opusInitialized = true;
    }

    // Phase 1: REST → DB membership
    await this.rest.joinVoiceChannel(channelId, serverId);

    // Phase 2: WS voice state join → triggers VOICE_READY on the server.
    // Advertise this SDK's max E2EE protocol version (v1 — frame E2EE
    // via `E2EEEncryptor`). Server negotiates the room's active
    // version as `min(all participants)`; if a v0-only device (current
    // iOS) is present, the whole room drops to transport-only and the
    // server's VOICE_READY response carries `e2ee: null`, at which
    // point `handleVoiceReady` below skips E2EEManager setup entirely.
    this.gateway.sendVoiceState('join', channelId, serverId, E2EE_PROTOCOL_VERSION);
    this.debug(`Joining voice channel ${channelId} in server ${serverId}`);
  }

  /** Leave the current voice channel. Best-effort; never throws. */
  async leave(): Promise<void> {
    // Flush any dangling speaking state before the leave op so the
    // fan-out order is (speaking_stop → leave) not (leave → stale
    // speaking bit on the client's atom for the torn-down
    // participant). setSpeaking is a no-op if we weren't speaking.
    this.setSpeaking(false);
    this.gateway.sendVoiceState('leave');
    try {
      await this.rest.leaveVoiceChannel();
    } catch {
      // Best-effort — REST leave is a hint, the WS leave is authoritative.
    }
    this.destroy();
  }

  /**
   * Update the bot's speaking state. Idempotent — repeated calls with
   * the same value are dropped. Emits `VOICE_STATE:speaking_start` /
   * `speaking_stop` to the signaling server, which fans out
   * `VOICE_STATE_UPDATE` to every other participant so their client
   * UIs can light / dim the glow ring around the bot's avatar.
   *
   * ## Usage pattern
   *
   * Call this from the bot's playback state machine at every point
   * audio starts or stops flowing. For a music bot, that's:
   *
   *   - `setSpeaking(true)` when a track starts playing (or resumes
   *     from pause).
   *   - `setSpeaking(false)` on pause, stop, skip-to-empty-queue,
   *     destroy, or any other silence transition.
   *
   * Continuous-playback bots should NOT drive this from a heartbeat
   * on `sendOpus` calls — the state-machine approach has zero latency
   * on transitions, no polling overhead, and is resilient to brief
   * silence gaps within a track (FFmpeg buffer drains, etc.) that
   * would otherwise flicker the ring off and on.
   *
   * ## Reconnect resilience
   *
   * The state is cached in the VoiceConnection and re-emitted
   * automatically from `handleVoiceReady` on every fresh VOICE_READY
   * dispatch. So if the WS drops mid-track and the bot rejoins
   * voice, the glow ring will light back up as soon as the new
   * voice session starts — the bot code doesn't need to retry the
   * call itself. This closes a hole that existed in the historical
   * music bot (pre-SDK split) which had no reconnect handling.
   *
   * @param value — `true` when audio starts flowing, `false` when it
   *                stops. No-ops if the connection is `idle` or
   *                `leaving`, or if the value matches the current
   *                cached state.
   */
  setSpeaking(value: boolean): void {
    if (this.speakingState === value) return;
    if (this.state === 'idle' || this.state === 'leaving') return;
    this.speakingState = value;
    if (this.channelId == null || this.serverId == null) return;
    this.gateway.sendVoiceState(
      value ? 'speaking_start' : 'speaking_stop',
      this.channelId,
      this.serverId,
    );
    this.debug(`setSpeaking(${value}) — emitted op`);
  }

  /**
   * Queue a PCM audio frame for sending. Each call must be exactly one
   * 20ms stereo-interleaved Int16LE frame (3840 bytes, 960 frames per
   * channel). See `opus.ts` for the frame layout.
   */
  sendAudio(pcm: Buffer): void {
    if (!this.canSend()) return;
    try {
      const opus = encodeOpus(pcm);
      this.sendRtp(opus);
    } catch (err) {
      this.debug(`Send audio error: ${err}`);
    }
  }

  /**
   * Queue an already-encoded Opus frame for sending. Use this when
   * streaming pre-encoded audio straight from ffmpeg's libopus output.
   */
  sendOpus(opusFrame: Buffer): void {
    if (!this.canSend()) return;
    this.sendRtp(opusFrame);
  }

  private canSend(): boolean {
    return (
      this.state === 'ready' &&
      this.rtpSender !== null &&
      this.sendSocket !== null &&
      this.sendAddr !== null
    );
  }

  private sendRtp(opusFrame: Buffer): void {
    // canSend() guards all four fields — the non-null assertions below
    // are safe for the whole method.
    //
    // E2EE: encrypt the Opus frame BEFORE RTP packing. The encryptor
    // produces [TOC(1B) | ciphertext | tag(8B)] which the RTP sender
    // wraps with the RTP header. Browser clients' RTCRtpScriptTransform
    // decrypts after stripping the RTP header — same frame format.
    // If the encryptor is not initialized (no keys yet), send cleartext
    // as a fallback (matches historical behaviour).
    const frame = this.encryptor?.encrypt(opusFrame) ?? opusFrame;
    const packet = this.rtpSender!.pack(frame);
    this.sendSocket!.send(packet, this.sendAddr!.port, this.sendAddr!.ip);
  }

  // ─── Gateway Event Handlers (wired by BotClient) ────────────────

  /**
   * VOICE_READY — the server has created our room membership and is
   * ready for the transport setup dance.
   */
  handleVoiceReady(data: VoiceReadyPayload): void {
    if (this.state !== 'joining') {
      this.debug(`VOICE_READY in state ${this.state} — ignoring`);
      return;
    }

    this.voiceSessionId = data.voiceSessionId;

    // Cache the router's RtpCapabilities — every VOICE_CONSUME echoes
    // this verbatim so the server's `router.can_consume(...)` check
    // always sees the full superset. See `consumeProducer` below.
    this.routerRtpCapabilities = data.routerRtpCapabilities;

    // E2EE keys (optional — the server omits this if E2EE is disabled).
    if (data.e2ee) {
      this.e2ee.setKeys(data.e2ee.epochSecret);
      // Initialize outgoing encryptor so bot-produced Opus frames are
      // encrypted before RTP packing. Without this, browser clients'
      // decryptors fail-then-passthrough (audible but not confidential).
      const botUserId = this.gateway.userId;
      if (botUserId) {
        this.encryptor = new E2EEEncryptor(botUserId);
        this.encryptor.init(data.e2ee.epochSecret);
      }
      this.debug(`E2EE keys set (epoch ${data.e2ee.epoch}), encryptor ${botUserId ? 'active' : 'skipped (no userId)'}`);
    }

    // Stash the existingProducers list — we'll consume them once the
    // recv transport is ready. Consuming now would trip Rust's
    // `no recv transport for consume` guard.
    this.pendingProducers = data.existingProducers.map((p) => ({
      producerId: p.producerId,
      userId: p.userId,
    }));

    this.state = 'readySentXportReq';
    this.gateway.sendBotVoiceTransport('send');
    this.debug(
      `VOICE_READY — requesting send transport (${this.pendingProducers.length} existing producers queued)`,
    );

    // Phase 7 — reconnect resilience. If we were speaking before the
    // WS dropped, re-emit the speaking_start op now that a fresh
    // voice session is live. This is idempotent against the server's
    // `handle_speaking` cache write (which sets the same value the
    // bot already thinks it has) and cost-free on first-join (the
    // temporary `cached = false; setSpeaking(false)` path is a
    // no-op on the idempotency guard).
    //
    // We temporarily clear `speakingState` so `setSpeaking` will
    // actually fire the op — the idempotency guard would otherwise
    // see "already true" and skip. The alternative (bypassing the
    // helper) would duplicate the gateway call logic.
    if (this.speakingState) {
      this.speakingState = false;
      this.setSpeaking(true);
    }
  }

  /**
   * BOT_VOICE_TRANSPORT_CREATED — the server has allocated a
   * PlainTransport for us and told us where to send/receive RTP.
   */
  handleTransportCreated(data: BotVoiceTransportCreatedPayload): void {
    if (data.direction === 'send') {
      this.handleSendTransportCreated(data);
    } else {
      this.handleRecvTransportCreated(data);
    }
  }

  private handleSendTransportCreated(data: BotVoiceTransportCreatedPayload): void {
    if (this.state !== 'readySentXportReq') {
      this.debug(`send transport created in state ${this.state} — ignoring`);
      return;
    }

    this.sendTransportId = data.transportId;
    this.sendAddr = { ip: data.ip, port: data.port };
    this.sendSocket = dgram.createSocket('udp4');

    // Pre-generate the SSRC so rtpParameters.encodings[0].ssrc and the
    // RtpSender created in handleProduceReady share the same value.
    // mediasoup-rust drops any RTP packet whose header SSRC doesn't match
    // the producer's declared SSRC.
    //
    // Range 1..=0x7fffffff stays safely inside u32 and avoids SSRC 0
    // (which some stacks treat as unset).
    this.sendSsrc = (Math.floor(Math.random() * 0x7fffffff) + 1) >>> 0;

    // Build the full rtpParameters payload. Required fields per
    // `mediasoup-types::RtpParameters`: codecs, encodings, rtcp —
    // headerExtensions is strictly required by the deserializer (no
    // `#[serde(default)]`) but an empty array is accepted.
    //
    // Codec matches the router spec at workers.rs:237-246 byte for byte.
    // mediasoup-rust's `match_codecs` at ortc.rs:1055 is strict on mime,
    // clock rate, channels (does NOT check audio parameters for plain
    // Opus — only for MultiChannelOpus — but we still send the router's
    // recommended parameters for bitstream quality).
    const rtpParameters = {
      codecs: [
        {
          mimeType: 'audio/opus',
          payloadType: OPUS_PAYLOAD_TYPE,
          clockRate: OPUS_CLOCK_RATE,
          channels: OPUS_CHANNELS,
          parameters: {
            minptime: 10,
            useinbandfec: 1,
            usedtx: 1,
          },
          rtcpFeedback: [],
        },
      ],
      headerExtensions: [],
      encodings: [
        {
          ssrc: this.sendSsrc,
          dtx: true,
        },
      ],
      rtcp: {
        cname: `relay-bot-${this.sendSsrc}`,
        reducedSize: true,
      },
    };

    this.state = 'sendXportReady';
    this.gateway.sendVoiceProduce(data.transportId, 'audio', rtpParameters);
    this.debug(
      `Send transport created ${data.ip}:${data.port} (id ${data.transportId}, ssrc ${this.sendSsrc})`,
    );
  }

  private handleRecvTransportCreated(data: BotVoiceTransportCreatedPayload): void {
    if (this.state !== 'producing') {
      this.debug(`recv transport created in state ${this.state} — ignoring`);
      return;
    }

    this.recvTransportId = data.transportId;
    this.recvAddr = { ip: data.ip, port: data.port };
    this.setupRecvSocket(data.ip, data.port);
    this.state = 'ready';

    this.onReady?.();
    this.debug(
      `Recv transport created ${data.ip}:${data.port} (id ${data.transportId}) — voice connection fully ready`,
    );

    // NOW it's safe to consume the producers we stashed from VOICE_READY.
    const pending = this.pendingProducers;
    this.pendingProducers = [];
    for (const p of pending) {
      this.consumeProducer(p.producerId, p.userId);
    }
  }

  /**
   * VOICE_PRODUCE_READY — our producer is live. Create the RtpSender
   * (reusing the SSRC we declared in rtpParameters) and request the
   * recv transport for the consume side.
   */
  handleProduceReady(data: VoiceProduceReadyPayload): void {
    if (this.state !== 'sendXportReady') {
      this.debug(`VOICE_PRODUCE_READY in state ${this.state} — ignoring`);
      return;
    }
    if (this.sendSsrc == null || !this.sendSocket || !this.sendAddr) {
      this.debug('VOICE_PRODUCE_READY without send socket/ssrc — inconsistent state');
      return;
    }

    this.rtpSender = new RtpSender(this.sendSsrc, OPUS_PAYLOAD_TYPE, OPUS_CLOCK_RATE);

    // Punch the send PlainTransport. `comedia: true` means mediasoup
    // learns our remote address from the first packet we send, so this
    // dummy opens the addr/port binding without touching the Opus path.
    const dummy = Buffer.alloc(12 + 3);
    dummy[0] = 0x80;
    dummy[1] = OPUS_PAYLOAD_TYPE;
    this.sendSocket.send(dummy, this.sendAddr.port, this.sendAddr.ip);

    this.state = 'producing';
    this.gateway.sendBotVoiceTransport('recv');
    this.debug(`Producer ready: ${data.producerId} — requesting recv transport`);
  }

  /**
   * VOICE_CONSUMER_CREATED — one of our VOICE_CONSUME calls succeeded.
   * Record the SSRC→userId mapping so `handleIncomingRtp` can route
   * packets in O(1).
   */
  handleConsumerCreated(data: VoiceConsumerCreatedPayload): void {
    const userId = data.userId ?? 'unknown';
    const ssrc = data.rtpParameters?.encodings?.[0]?.ssrc;
    if (typeof ssrc === 'number') {
      this.ssrcToUser.set(ssrc, userId);
      this.producerToSsrc.set(data.producerId, ssrc);
    } else {
      this.debug(
        `VOICE_CONSUMER_CREATED for producer ${data.producerId} carried no ssrc in rtpParameters`,
      );
    }
    this.pendingConsumes.delete(data.producerId);
    this.debug(`Consumer created for ${userId} (producer ${data.producerId}, ssrc ${ssrc})`);
  }

  /**
   * NEW_PRODUCER — another participant just started producing. If we're
   * fully ready we can consume immediately; otherwise buffer for the
   * pendingProducers flush in `handleRecvTransportCreated`.
   */
  handleNewProducer(data: NewProducerPayload): void {
    if (this.state === 'ready') {
      this.consumeProducer(data.producerId, data.userId);
    } else {
      this.pendingProducers.push({ producerId: data.producerId, userId: data.userId });
      this.debug(
        `NEW_PRODUCER ${data.producerId} buffered — voice not yet ready (state=${this.state})`,
      );
    }
  }

  /**
   * PRODUCER_CLOSED — fan-out dispatch when a producer ends. Clean up
   * the SSRC mapping and E2EE decryptor for that sender.
   */
  handleProducerClosed(data: ProducerClosedPayload): void {
    const ssrc = this.producerToSsrc.get(data.producerId);
    if (ssrc != null) {
      this.ssrcToUser.delete(ssrc);
      this.producerToSsrc.delete(data.producerId);
    }
    this.pendingConsumes.delete(data.producerId);
    this.e2ee.removeSender(data.userId);
    this.debug(`Producer closed: ${data.producerId} (${data.userId}, ssrc ${ssrc ?? 'unknown'})`);
  }

  /** E2EE_KEY_UPDATE — epoch rotation after a room membership change. */
  handleE2EEKeyUpdate(data: E2EEKeyUpdatePayload): void {
    this.e2ee.updateKeys(data.epochSecret);
    this.encryptor?.updateKey(data.epochSecret);
    this.debug(`E2EE keys updated (epoch ${data.epoch})`);
  }

  // ─── Internal ───────────────────────────────────────────────────

  private consumeProducer(producerId: string, userId: string): void {
    // The Rust VOICE_CONSUME handler fails with `no recv transport for
    // consume` when called before the recv PlainTransport is ready. This
    // method is only called either from `handleNewProducer` (gated on
    // state==='ready') or from the `pendingProducers` flush in
    // `handleRecvTransportCreated` (which also flips state to 'ready').
    this.pendingConsumes.set(producerId, userId);
    // Echo the router's capabilities verbatim — the server calls
    // mediasoup's `router.can_consume(rtpCapabilities)` which does strict
    // ORTC matching. The router's own capabilities are the universal
    // "accept anything" value, and we don't need to construct a bot-side
    // subset.
    this.gateway.sendVoiceConsume(producerId, this.routerRtpCapabilities);
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

    // Punch the recv PlainTransport with a dummy packet (comedia — see
    // the matching dummy send in handleProduceReady).
    const dummy = Buffer.alloc(12 + 3);
    dummy[0] = 0x80;
    dummy[1] = OPUS_PAYLOAD_TYPE;
    this.recvSocket.send(dummy, port, ip);
  }

  private handleIncomingRtp(buf: Buffer): void {
    const packet = parseRtpPacket(buf);
    if (!packet || packet.payload.length === 0) return;

    // Route by SSRC directly. The consumer's SSRC was captured on
    // VOICE_CONSUMER_CREATED and stored in ssrcToUser.
    const userId = this.ssrcToUser.get(packet.header.ssrc);
    if (!userId) {
      // No mapping yet — either the consumer created dispatch hasn't
      // arrived, or this is a stray packet from a producer we never
      // consumed. Either way, drop.
      return;
    }

    // E2EE decrypt if we have a key for this sender. Frames sent by
    // clients on the app side are AES-128-GCM encrypted; plain PCM from
    // bot→bot (which shouldn't happen in current deployment) would come
    // through with no encryption.
    const decryptor = this.e2ee.getDecryptor(userId);
    const decrypted = decryptor.decrypt(packet.payload) ?? packet.payload;

    this.emitDecodedAudio(userId, decrypted);
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
    this.state = 'leaving';

    this.sendSocket?.close();
    this.sendSocket = null;
    this.recvSocket?.close();
    this.recvSocket = null;

    this.sendAddr = null;
    this.recvAddr = null;
    this.sendTransportId = null;
    this.recvTransportId = null;
    this.sendSsrc = null;
    this.rtpSender = null;

    this.pendingProducers = [];
    this.pendingConsumes.clear();
    this.ssrcToUser.clear();
    this.producerToSsrc.clear();

    this.routerRtpCapabilities = null;
    this.e2ee.destroy();
    this.encryptor?.destroy();
    this.encryptor = null;

    this.channelId = null;
    this.serverId = null;
    this.voiceSessionId = null;
    // Reset speaking state — next join() starts from a clean slate.
    // Any caller that wants to persist speaking across a full
    // teardown/rejoin should track that intent themselves.
    this.speakingState = false;

    this.onDestroyed?.();
    this.debug('Voice connection destroyed');
    this.state = 'idle';
  }
}
