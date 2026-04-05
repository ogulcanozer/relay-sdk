/**
 * Cache — in-memory cache for Relay entities.
 *
 * Populated from two sources:
 * 1. REST responses (lazy fetch on cache miss)
 * 2. Gateway events (proactive updates from server pushes)
 *
 * TTL-based staleness: short for frequently-changing data (members, roles),
 * longer for stable data (servers, channels).
 */

import type { RESTClient } from './rest.js';
import type {
  ServerResponse,
  ChannelResponse,
  MemberResponse,
  RoleResponse,
  UserResponse,
  MemberJoinPayload,
  MemberLeavePayload,
  MessagePayload,
} from './types.js';

// ─── TTL Constants ───────────────────────────────────────────────────

/** 30 minutes — servers and channels rarely change */
const TTL_STABLE_MS = 30 * 60 * 1000;

/** 5 minutes — members and roles change more often */
const TTL_VOLATILE_MS = 5 * 60 * 1000;

// ─── Cache Entry ─────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

function isStale<T>(entry: CacheEntry<T> | undefined, ttlMs: number): boolean {
  if (!entry) return true;
  return Date.now() - entry.fetchedAt > ttlMs;
}

function wrap<T>(data: T): CacheEntry<T> {
  return { data, fetchedAt: Date.now() };
}

// ─── Cache ───────────────────────────────────────────────────────────

export class Cache {
  private servers = new Map<string, CacheEntry<ServerResponse>>();
  private channels = new Map<string, CacheEntry<ChannelResponse>>();
  private serverChannels = new Map<string, CacheEntry<ChannelResponse[]>>();
  private members = new Map<string, Map<string, CacheEntry<MemberResponse>>>();
  private serverMembersFetched = new Map<string, CacheEntry<true>>();
  private roles = new Map<string, CacheEntry<RoleResponse[]>>();
  private users = new Map<string, CacheEntry<UserResponse>>();

  constructor(
    private readonly rest: RESTClient,
    private readonly debugFn: (msg: string) => void,
  ) {}

  // ─── Lazy Getters (REST fallback on miss) ───────────────────────

  async getServer(serverId: string): Promise<ServerResponse> {
    const cached = this.servers.get(serverId);
    if (!isStale(cached, TTL_STABLE_MS)) return cached!.data;

    this.debug(`server ${serverId}: cache miss, fetching`);
    const server = await this.rest.getServer(serverId);
    this.servers.set(serverId, wrap(server));

    // Also cache the embedded channels
    if (server.channels) {
      this.cacheChannelList(serverId, server.channels);
    }

    return server;
  }

  async getChannels(serverId: string): Promise<ChannelResponse[]> {
    const cached = this.serverChannels.get(serverId);
    if (!isStale(cached, TTL_STABLE_MS)) return cached!.data;

    this.debug(`channels for server ${serverId}: cache miss, fetching`);
    const channels = await this.rest.listChannels(serverId);
    this.cacheChannelList(serverId, channels);
    return channels;
  }

  async getMembers(serverId: string): Promise<MemberResponse[]> {
    const fetched = this.serverMembersFetched.get(serverId);
    if (!isStale(fetched, TTL_VOLATILE_MS)) {
      const memberMap = this.members.get(serverId);
      if (memberMap) {
        return Array.from(memberMap.values(), (e) => e.data);
      }
    }

    this.debug(`members for server ${serverId}: cache miss, fetching`);
    const members = await this.rest.listMembers(serverId);
    this.cacheMemberList(serverId, members);
    return members;
  }

  async getMember(serverId: string, userId: string): Promise<MemberResponse | null> {
    const memberMap = this.members.get(serverId);
    const cached = memberMap?.get(userId);
    if (!isStale(cached, TTL_VOLATILE_MS)) return cached!.data;

    // Fetch full member list if we don't have it — no single-member endpoint
    const members = await this.getMembers(serverId);
    return members.find((m) => m.userId === userId) ?? null;
  }

  async getRoles(serverId: string): Promise<RoleResponse[]> {
    const cached = this.roles.get(serverId);
    if (!isStale(cached, TTL_VOLATILE_MS)) return cached!.data;

    this.debug(`roles for server ${serverId}: cache miss, fetching`);
    const roles = await this.rest.listRoles(serverId);
    this.roles.set(serverId, wrap(roles));
    return roles;
  }

  async getUser(userId: string): Promise<UserResponse> {
    const cached = this.users.get(userId);
    if (!isStale(cached, TTL_VOLATILE_MS)) return cached!.data;

    this.debug(`user ${userId}: cache miss, fetching`);
    const user = await this.rest.getUser(userId);
    this.users.set(userId, wrap(user));
    return user;
  }

  // ─── Direct Cache Access (no REST fallback) ─────────────────────

  getCachedServer(serverId: string): ServerResponse | undefined {
    return this.servers.get(serverId)?.data;
  }

  getCachedUser(userId: string): UserResponse | undefined {
    return this.users.get(userId)?.data;
  }

  // ─── Gateway Event Handlers ─────────────────────────────────────

  handleMemberJoin(payload: MemberJoinPayload): void {
    const memberMap = this.members.get(payload.serverId);
    if (!memberMap) return; // Server members not cached yet — skip

    const member: MemberResponse = {
      userId: payload.user.id,
      username: payload.user.username,
      discriminator: payload.user.discriminator,
      displayName: payload.user.displayName,
      avatarUrl: payload.user.avatarUrl,
      isBot: payload.user.isBot,
      joinedAt: new Date().toISOString(),
      roles: [],
    };
    memberMap.set(payload.user.id, wrap(member));
    this.debug(`member join: ${payload.user.username} in server ${payload.serverId}`);

    // Update server member count if cached
    const server = this.servers.get(payload.serverId);
    if (server) {
      server.data = { ...server.data, memberCount: server.data.memberCount + 1 };
    }
  }

  handleMemberLeave(payload: MemberLeavePayload): void {
    const memberMap = this.members.get(payload.serverId);
    if (memberMap) {
      memberMap.delete(payload.userId);
    }
    this.debug(`member leave: ${payload.userId} from server ${payload.serverId}`);

    // Update server member count if cached
    const server = this.servers.get(payload.serverId);
    if (server && server.data.memberCount > 0) {
      server.data = { ...server.data, memberCount: server.data.memberCount - 1 };
    }
  }

  handlePresenceUpdate(payload: { userId: string; status: string }): void {
    const cached = this.users.get(payload.userId);
    if (cached) {
      cached.data = { ...cached.data, status: payload.status };
    }
  }

  handleMessageCreate(payload: MessagePayload): void {
    // Cache author info from message payload — free data, no extra REST call
    if (payload.author) {
      const existing = this.users.get(payload.authorId);
      // Only populate if we don't already have fresh data
      if (!existing || isStale(existing, TTL_VOLATILE_MS)) {
        this.users.set(payload.authorId, wrap({
          id: payload.author.id,
          username: payload.author.username,
          discriminator: payload.author.discriminator,
          displayName: payload.author.displayName,
          avatarUrl: payload.author.avatarUrl,
          status: 'online', // Author just sent a message — they're online
          customStatus: null,
          isBot: payload.author.isBot,
        }));
      }
    }
  }

  // ─── Invalidation ──────────────────────────────────────────────

  invalidateServer(serverId: string): void {
    this.servers.delete(serverId);
    this.serverChannels.delete(serverId);
    this.debug(`invalidated server ${serverId}`);
  }

  invalidateMembers(serverId: string): void {
    this.members.delete(serverId);
    this.serverMembersFetched.delete(serverId);
    this.debug(`invalidated members for server ${serverId}`);
  }

  clear(): void {
    this.servers.clear();
    this.channels.clear();
    this.serverChannels.clear();
    this.members.clear();
    this.serverMembersFetched.clear();
    this.roles.clear();
    this.users.clear();
    this.debug('cache cleared');
  }

  // ─── Internal ──────────────────────────────────────────────────

  private cacheChannelList(serverId: string, channels: ChannelResponse[]): void {
    this.serverChannels.set(serverId, wrap(channels));
    for (const channel of channels) {
      this.channels.set(channel.id, wrap(channel));
    }
  }

  private cacheMemberList(serverId: string, members: MemberResponse[]): void {
    const memberMap = new Map<string, CacheEntry<MemberResponse>>();
    for (const member of members) {
      memberMap.set(member.userId, wrap(member));
    }
    this.members.set(serverId, memberMap);
    this.serverMembersFetched.set(serverId, wrap(true));
  }

  private debug(msg: string): void {
    this.debugFn(`[Cache] ${msg}`);
  }
}
