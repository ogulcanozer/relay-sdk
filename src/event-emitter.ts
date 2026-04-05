/**
 * Type-safe event emitter.
 *
 * Provides compile-time checked event names and listener signatures.
 * Used as the base for BotClient — `client.on('messageCreate', msg => ...)`
 * has full autocomplete and type inference.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class TypedEmitter<Events extends Record<string, any[]> = Record<string, any[]>> {
  private listeners = new Map<keyof Events, Set<(...args: unknown[]) => void>>();

  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (...args: unknown[]) => void);
    return this;
  }

  once<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): this {
    const wrapper = ((...args: Events[K]) => {
      this.off(event, wrapper);
      listener(...args);
    }) as (...args: Events[K]) => void;
    return this.on(event, wrapper);
  }

  off<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): this {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener as (...args: unknown[]) => void);
      if (set.size === 0) this.listeners.delete(event);
    }
    return this;
  }

  protected emit<K extends keyof Events>(event: K, ...args: Events[K]): boolean {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return false;
    for (const listener of set) {
      try {
        listener(...args);
      } catch (err) {
        // Don't let one listener crash others
        console.error(`[TypedEmitter] Listener error on "${String(event)}":`, err);
      }
    }
    return true;
  }

  removeAllListeners<K extends keyof Events>(event?: K): this {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
    return this;
  }

  listenerCount<K extends keyof Events>(event: K): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
