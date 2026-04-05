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

export interface VoiceConsumerCreatedPayload {
  consumerId: string;
  producerId: string;
  kind: string;
  producerType?: string;
  userId?: string;
  ip: string;
  port: number;
  rtcpPort?: number;
  rtpParameters: unknown;
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
