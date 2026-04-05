// ─── Core ────────────────────────────────────────────────────────────
export { BotClient, Intents, type BotClientOptions } from './client.js';
export { RESTClient, type RESTOptions } from './rest.js';
export { Gateway, type GatewayOptions } from './gateway.js';
export { TypedEmitter } from './event-emitter.js';

// ─── Types ───────────────────────────────────────────────────────────
export type {
  ClientEvents,
  CommandDefinition,
  CommandParameter,
  CommandInteraction,
  ReadyPayload,
  BotUser,
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
  WSMessage,
} from './types.js';

export { Op } from './types.js';
