/**
 * Command Framework — declarative slash command routing with typed contexts.
 *
 * Usage:
 *   const commands = new CommandRouter(client);
 *
 *   commands.slash('note', 'Save a note')
 *     .string('text', 'The note text', true)
 *     .access('everyone')
 *     .handle(async (ctx) => {
 *       const text = ctx.getString('text')!;
 *       ctx.reply('Noted!', { embeds: [...] });
 *     });
 *
 *   commands.button('confirm_delete', async (ctx) => {
 *     ctx.editOriginal('Deleted.', { components: null });
 *   });
 *
 *   await commands.register();  // Syncs with API + starts routing
 */

import type { BotClient } from './client.js';
import type {
  CommandDefinition,
  CommandParameter,
  CommandInteraction,
  ComponentInteraction,
  Embed,
  ActionRow,
} from './types.js';

// ─── Command Context ────────────────────────────────────────────────

/** Wraps a CommandInteraction with typed argument accessors and response helpers. */
export class CommandContext {
  readonly interaction: CommandInteraction;
  private readonly client: BotClient;

  constructor(interaction: CommandInteraction, client: BotClient) {
    this.interaction = interaction;
    this.client = client;
  }

  /** The server ID where the command was invoked. */
  get serverId(): string { return this.interaction.serverId; }

  /** The channel ID where the command was invoked. */
  get channelId(): string { return this.interaction.channelId; }

  /** The user ID who invoked the command. */
  get userId(): string { return this.interaction.userId; }

  /** The raw content of the message. */
  get rawContent(): string { return this.interaction.rawContent; }

  /** Get a string argument by name. */
  getString(name: string): string | undefined {
    const val = this.interaction.arguments[name];
    return typeof val === 'string' ? val : val !== undefined ? String(val) : undefined;
  }

  /** Get an integer argument by name. */
  getInteger(name: string): number | undefined {
    const val = this.interaction.arguments[name];
    if (typeof val === 'number') return Math.floor(val);
    if (typeof val === 'string') {
      const n = parseInt(val, 10);
      return isNaN(n) ? undefined : n;
    }
    return undefined;
  }

  /** Get a boolean argument by name. */
  getBoolean(name: string): boolean | undefined {
    const val = this.interaction.arguments[name];
    if (typeof val === 'boolean') return val;
    if (val === 'true') return true;
    if (val === 'false') return false;
    return undefined;
  }

  /** Reply to the interaction. */
  reply(content: string, opts?: { ephemeral?: boolean; embeds?: Embed[]; components?: ActionRow[] }): void {
    this.client.reply(this.interaction, content, opts);
  }

  /** Show a "thinking..." indicator. */
  defer(): void {
    this.client.defer(this.interaction);
  }

  /** Send a follow-up message to the same channel. */
  async followUp(content: string, opts?: { embeds?: Embed[]; components?: ActionRow[] }): Promise<void> {
    await this.client.sendMessage(this.channelId, content, opts);
  }
}

// ─── Component Context ──────────────────────────────────────────────

/** Wraps a ComponentInteraction with response helpers. */
export class ComponentContext {
  readonly interaction: ComponentInteraction;
  private readonly client: BotClient;

  constructor(interaction: ComponentInteraction, client: BotClient) {
    this.interaction = interaction;
    this.client = client;
  }

  /** The custom ID of the clicked component. */
  get customId(): string { return this.interaction.customId; }

  /** The message ID the component belongs to. */
  get messageId(): string { return this.interaction.messageId; }

  /** The channel ID (if available). */
  get channelId(): string | undefined { return this.interaction.channelId; }

  /** The server ID (if available). */
  get serverId(): string | undefined { return this.interaction.serverId; }

  /** The user who clicked. */
  get userId(): string { return this.interaction.userId; }

  /** Selected values (for select menus). */
  get values(): string[] | undefined { return this.interaction.values; }

  /** Structured metadata attached to the component. */
  get metadata(): Record<string, unknown> | undefined { return this.interaction.metadata; }

  /** Edit the original message (e.g., to strip buttons). Pass components: null to remove. */
  async editOriginal(content: string, opts?: { embeds?: Embed[]; components?: ActionRow[] | null }): Promise<void> {
    await this.client.editMessage(this.messageId, content, opts);
  }

  /** Send a new message to the same channel. */
  async reply(content: string, opts?: { embeds?: Embed[]; components?: ActionRow[] }): Promise<void> {
    if (!this.channelId) return;
    await this.client.sendMessage(this.channelId, content, opts);
  }
}

// ─── Slash Command Builder ──────────────────────────────────────────

type CommandHandler = (ctx: CommandContext) => void | Promise<void>;

export class SlashCommand {
  private def: CommandDefinition;
  private _handler: CommandHandler | null = null;

  constructor(name: string, description: string) {
    this.def = { name, description };
  }

  /** Add a string parameter. */
  string(name: string, description: string, required = false): this {
    this.addParam({ name, description, type: 'string', required });
    return this;
  }

  /** Add an integer parameter. */
  integer(name: string, description: string, required = false): this {
    this.addParam({ name, description, type: 'integer', required });
    return this;
  }

  /** Add a boolean parameter. */
  boolean(name: string, description: string, required = false): this {
    this.addParam({ name, description, type: 'boolean', required });
    return this;
  }

  /** Set the default access level. */
  access(level: 'everyone' | 'admin_only'): this {
    this.def.defaultAccess = level;
    return this;
  }

  /** Set a cooldown in seconds. */
  cooldown(seconds: number): this {
    this.def.cooldownSeconds = seconds;
    return this;
  }

  /** Set the handler for this command. */
  handle(handler: CommandHandler): this {
    this._handler = handler;
    return this;
  }

  private addParam(param: CommandParameter): void {
    if (!this.def.parameters) this.def.parameters = [];
    this.def.parameters.push(param);
  }

  /** @internal */
  toDefinition(): CommandDefinition { return this.def; }
  /** @internal */
  getHandler(): CommandHandler | null { return this._handler; }
}

// ─── Command Router ─────────────────────────────────────────────────

type ComponentHandler = (ctx: ComponentContext) => void | Promise<void>;

export class CommandRouter {
  private readonly client: BotClient;
  private readonly commands = new Map<string, SlashCommand>();
  private readonly buttonHandlers = new Map<string, ComponentHandler>();
  private readonly selectHandlers = new Map<string, ComponentHandler>();
  private readonly buttonPrefixHandlers: Array<{ prefix: string; handler: ComponentHandler }> = [];
  private readonly selectPrefixHandlers: Array<{ prefix: string; handler: ComponentHandler }> = [];

  constructor(client: BotClient) {
    this.client = client;
  }

  /** Define a slash command with a fluent builder. */
  slash(name: string, description: string): SlashCommand {
    const cmd = new SlashCommand(name, description);
    this.commands.set(name, cmd);
    return cmd;
  }

  /** Register a handler for an exact button customId. */
  button(customId: string, handler: ComponentHandler): this {
    this.buttonHandlers.set(customId, handler);
    return this;
  }

  /** Register a handler for buttons whose customId starts with a prefix. */
  buttonPrefix(prefix: string, handler: ComponentHandler): this {
    this.buttonPrefixHandlers.push({ prefix, handler });
    return this;
  }

  /** Register a handler for an exact select menu customId. */
  select(customId: string, handler: ComponentHandler): this {
    this.selectHandlers.set(customId, handler);
    return this;
  }

  /** Register a handler for select menus whose customId starts with a prefix. */
  selectPrefix(prefix: string, handler: ComponentHandler): this {
    this.selectPrefixHandlers.push({ prefix, handler });
    return this;
  }

  /** Register all commands with the API and start routing interactions. */
  async register(): Promise<number> {
    const defs = Array.from(this.commands.values()).map((c) => c.toDefinition());
    const count = await this.client.registerCommands(defs);

    // Wire command interactions
    this.client.on('commandInteraction', (interaction: CommandInteraction) => {
      const cmd = this.commands.get(interaction.commandName);
      const handler = cmd?.getHandler();
      if (handler) {
        const ctx = new CommandContext(interaction, this.client);
        Promise.resolve(handler(ctx)).catch((err) => {
          console.error('[CommandRouter] Handler error:', err);
        });
      }
    });

    // Wire component interactions
    this.client.on('componentInteraction', (interaction: ComponentInteraction) => {
      const ctx = new ComponentContext(interaction, this.client);

      // Exact match first
      const handlers = interaction.componentType === 'select' ? this.selectHandlers : this.buttonHandlers;
      const exact = handlers.get(interaction.customId);
      if (exact) {
        Promise.resolve(exact(ctx)).catch((err) => {
          console.error('[CommandRouter] Handler error:', err);
        });
        return;
      }

      // Prefix match
      const prefixes = interaction.componentType === 'select' ? this.selectPrefixHandlers : this.buttonPrefixHandlers;
      for (const { prefix, handler } of prefixes) {
        if (interaction.customId.startsWith(prefix)) {
          Promise.resolve(handler(ctx)).catch((err) => {
            console.error('[CommandRouter] Handler error:', err);
          });
          return;
        }
      }
    });

    return count;
  }
}
