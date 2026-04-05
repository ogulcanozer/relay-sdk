/**
 * REST client for Relay API.
 *
 * Wraps tRPC HTTP endpoints with typed methods. Uses the `Bot <token>` auth header.
 * All bot-accessible endpoints go through `authenticatedProcedure` on the server.
 */

import type { CommandDefinition } from './types.js';

export interface RESTOptions {
  apiUrl: string;
  token: string;
}

export class RESTClient {
  private apiUrl: string;
  private token: string;

  constructor(options: RESTOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, '');
    this.token = options.token;
  }

  // ─── Commands ────────────────────────────────────────────────────

  async registerCommands(commands: CommandDefinition[]): Promise<number> {
    const data = await this.post<{ registered: number }>('bot.registerCommands', { commands });
    return data.registered;
  }

  // ─── Voice ───────────────────────────────────────────────────────

  async joinVoiceChannel(channelId: string, serverId: string): Promise<{ channelId: string; serverId: string }> {
    return this.post('voice.joinChannel', { channelId, serverId });
  }

  async leaveVoiceChannel(): Promise<void> {
    await this.post('voice.leaveChannel', {});
  }

  // ─── Messages ────────────────────────────────────────────────────

  async sendMessage(channelId: string, serverId: string, content: string): Promise<unknown> {
    return this.post('message.send', { channelId, serverId, content });
  }

  // ─── Internal ────────────────────────────────────────────────────

  private async post<T = unknown>(procedure: string, input: unknown): Promise<T> {
    const url = `${this.apiUrl}/api/trpc/${procedure}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bot ${this.token}`,
      },
      body: JSON.stringify(input),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`REST ${procedure} failed (${res.status}): ${text}`);
    }

    const json = await res.json() as { result?: { data: T } };
    if (!json.result?.data) {
      throw new Error(`REST ${procedure}: unexpected response shape`);
    }
    return json.result.data;
  }
}
