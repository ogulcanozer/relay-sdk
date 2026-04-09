/**
 * Relay Bot SDK — Core Types
 *
 * Vendored from @relay/shared and signaling-server protocol.
 * No cross-repo dependency — types are self-contained.
 */

// ─── WS Protocol ─────────────────────────────────────────────────────

export const Op = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 3,
  HEARTBEAT_ACK: 4,
  VOICE_STATE: 5,
  TYPING_START: 6,
  VOICE_TRANSPORT: 7,
  VOICE_PRODUCE: 8,
  VOICE_CONSUME: 9,
  VOICE_RESUME: 10,
  VOICE_PAUSE: 11,
  COMMAND_INTERACTION: 12,
  INTERACTION_RESPONSE: 13,
  BOT_VOICE_TRANSPORT: 14,
  ACK_READ: 15,
  INTERACTION_DEFER: 16,
  CALL_ACTION: 17,
  MEDIA_ACTION: 18,
  COMPONENT_INTERACTION: 19,
} as const;

export interface WSMessage {
  op: number;
  d: unknown;
  s?: number;
  t?: string;
}

// ─── Gateway Events ──────────────────────────────────────────────────

export interface BotUser {
  id: string;
  username: string;
  discriminator: string;
  displayName: string | null;
  avatarUrl: string | null;
  isBot: boolean;
}

export interface ReadyPayload {
  userId: string;
  sessionId: string;
  serverIds: string[];
  heartbeatInterval: number;
  user?: BotUser | null;
}

export interface CommandInteraction {
  interactionId: string;
  serverId: string;
  channelId: string;
  userId: string;
  commandName: string;
  arguments: Record<string, string | number | boolean>;
  rawContent: string;
  timestamp: string;
}

export interface MessagePayload {
  id: string;
  channelId: string;
  serverId?: string;
  authorId: string;
  content: string;
  type: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  author: {
    id: string;
    username: string;
    discriminator: string;
    displayName: string | null;
    avatarUrl: string | null;
    isBot: boolean;
  };
}

export interface VoiceStateUpdatePayload {
  userId: string;
  channelId: string | null;
  serverId: string;
  selfMute: boolean;
  selfDeaf: boolean;
}

export interface MemberJoinPayload {
  serverId: string;
  user: {
    id: string;
    username: string;
    discriminator: string;
    displayName: string | null;
    avatarUrl: string | null;
    isBot: boolean;
  };
}

export interface MemberLeavePayload {
  serverId: string;
  userId: string;
}

// ─── Voice Events ────────────────────────────────────────────────────

export interface VoiceReadyPayload {
  voiceSessionId: string;
  routerRtpCapabilities: unknown;
  participants: Array<{ userId: string; selfMute: boolean; selfDeaf: boolean }>;
  existingProducers: Array<{ producerId: string; userId: string; producerType?: string }>;
  e2ee?: {
    epoch: number;
    epochSecret: string;
    previousEpochSecret: string | null;
  };
}

export interface BotVoiceTransportCreatedPayload {
  transportId: string;
  direction: 'send' | 'recv';
  ip: string;
  port: number;
  rtcpPort?: number;
}

export interface VoiceProduceReadyPayload {
  producerId: string;
  kind: 'audio' | 'video';
  producerType?: string;
}

/**
 * Dispatched in response to a successful VOICE_CONSUME. Mirrors the JSON
 * the Rust signaling server builds in
 * `crates/signaling-server/src/media/voice_handler.rs` around line 1322.
 *
 * The ip/port/rtcpPort fields that older SDK revisions declared here are
 * NOT dispatched by the server — incoming RTP always lands on the bot's
 * recv PlainTransport socket (set up from the BOT_VOICE_TRANSPORT_CREATED
 * dispatch for `direction: 'recv'`).
 *
 * `rtpParameters` is the consumer's negotiated parameters as produced by
 * `mediasoup::Consumer::rtp_parameters()`. Its `encodings[0].ssrc` is the
 * SSRC the bot should filter incoming RTP packets on to route them to the
 * correct userId / E2EE key.
 */
export interface VoiceConsumerCreatedPayload {
  consumerId: string;
  producerId: string;
  kind: 'audio' | 'video';
  producerType?: string;
  userId?: string | null;
  rtpParameters: {
    codecs: Array<{ payloadType: number; [key: string]: unknown }>;
    encodings: Array<{ ssrc?: number; [key: string]: unknown }>;
    headerExtensions?: unknown[];
    rtcp?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface NewProducerPayload {
  producerId: string;
  userId: string;
  producerType?: string;
}

export interface ProducerClosedPayload {
  producerId: string;
  userId: string;
}

export interface E2EEKeyUpdatePayload {
  channelId: string;
  epoch: number;
  epochSecret: string;
  previousEpochSecret: string | null;
}

// ─── Command Definition ──────────────────────────────────────────────

export interface CommandParameter {
  name: string;
  description: string;
  type: 'string' | 'integer' | 'boolean' | 'user' | 'channel' | 'role';
  required?: boolean;
}

export interface CommandDefinition {
  name: string;
  description: string;
  parameters?: CommandParameter[];
  /** Access level: 'everyone' (default) or 'admin_only'. Server admins can override with role-based access. */
  defaultAccess?: 'everyone' | 'admin_only';
  /** Per-user cooldown in seconds between uses. */
  cooldownSeconds?: number;
}

// ─── REST Response Types ─────────────────────────────────────────────

export interface ServerResponse {
  id: string;
  name: string;
  iconUrl: string | null;
  ownerId: string;
  inviteCode: string;
  isPublicRoom: boolean;
  memberCount: number;
  channels: ChannelResponse[];
}

export interface ChannelResponse {
  id: string;
  serverId: string;
  name: string;
  type: 'text' | 'voice';
  topic: string | null;
  position: number;
}

export interface MemberResponse {
  userId: string;
  username: string;
  discriminator: string;
  displayName: string | null;
  avatarUrl: string | null;
  isBot: boolean;
  joinedAt: string;
  roles: string[];
}

export interface RoleResponse {
  id: string;
  name: string;
  color: string | null;
  position: number;
  permissions: string;
  isDefault: boolean;
}

export interface UserResponse {
  id: string;
  username: string;
  discriminator: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: string;
  customStatus: string | null;
  isBot: boolean;
  deleted?: boolean;
}

export interface MessageResponse {
  id: string;
  channelId: string;
  content: string;
  authorId: string;
  type: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  editedAt: string | null;
  author: {
    id: string;
    username: string;
    discriminator: string;
    displayName: string | null;
    avatarUrl: string | null;
    isBot: boolean;
  };
}

// ─── Components ─────────────────────────────────────────────────────

export interface ActionRow {
  type: 'actionRow';
  components: (Button | SelectMenu)[];
}

export interface Button {
  type: 'button';
  style: 'primary' | 'secondary' | 'danger' | 'link';
  label: string;
  customId?: string;
  url?: string;
  disabled?: boolean;
  emoji?: string;
  metadata?: Record<string, unknown>;
}

export interface SelectOption {
  label: string;
  value: string;
  description?: string;
  emoji?: string;
  default?: boolean;
}

export interface SelectMenu {
  type: 'select';
  customId: string;
  placeholder?: string;
  minValues?: number;
  maxValues?: number;
  disabled?: boolean;
  options: SelectOption[];
  metadata?: Record<string, unknown>;
}

export interface ComponentInteraction {
  type: 'component';
  interactionId: string;
  messageId: string;
  channelId?: string;
  serverId?: string;
  userId: string;
  customId: string;
  componentType: 'button' | 'select';
  values?: string[];
  metadata?: Record<string, unknown>;
}

// ─── Embeds ─────────────────────────────────────────────────────────

export interface Embed {
  title?: string;
  description?: string;
  url?: string;
  color?: string;
  timestamp?: string;
  footer?: { text: string; iconUrl?: string };
  author?: { name: string; url?: string; iconUrl?: string };
  thumbnail?: { url: string; width?: number; height?: number };
  image?: { url: string; width?: number; height?: number };
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

// ─── Bot Activity ───────────────────────────────────────────────────

export interface BotActivity {
  type: 'playing' | 'listening' | 'watching' | 'streaming' | 'custom';
  name: string;
  url?: string;
}

// ─── Client Events (typed emitter) ──────────────────────────────────

export type ClientEvents = {
  ready: [payload: ReadyPayload];
  commandInteraction: [interaction: CommandInteraction];
  messageCreate: [message: MessagePayload];
  messageUpdate: [message: MessagePayload];
  messageDelete: [payload: { id: string; channelId: string }];
  voiceStateUpdate: [payload: VoiceStateUpdatePayload];
  memberJoin: [payload: MemberJoinPayload];
  memberLeave: [payload: MemberLeavePayload];
  componentInteraction: [ComponentInteraction];
  serverDelete: [payload: { serverId: string }];

  // Voice pipeline events (internal, exposed for advanced use)
  voiceReady: [payload: VoiceReadyPayload];
  voiceTransportCreated: [payload: BotVoiceTransportCreatedPayload];
  voiceProduceReady: [payload: VoiceProduceReadyPayload];
  voiceConsumerCreated: [payload: VoiceConsumerCreatedPayload];
  newProducer: [payload: NewProducerPayload];
  producerClosed: [payload: ProducerClosedPayload];
  e2eeKeyUpdate: [payload: E2EEKeyUpdatePayload];

  // Lifecycle
  connected: [];
  disconnected: [];
  reconnecting: [attempt: number];
  error: [error: Error];
  debug: [message: string];
};
