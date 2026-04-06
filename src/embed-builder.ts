import type { Embed } from './types.js';

export class EmbedBuilder {
  private data: Embed = {};

  setTitle(title: string): this {
    if (title.length > 256) throw new RangeError('Embed title exceeds 256 characters');
    this.data.title = title;
    return this;
  }

  setDescription(description: string): this {
    if (description.length > 4096) throw new RangeError('Embed description exceeds 4096 characters');
    this.data.description = description;
    return this;
  }

  setURL(url: string): this {
    this.data.url = url;
    return this;
  }

  setColor(color: string): this {
    this.data.color = color;
    return this;
  }

  setTimestamp(date?: Date): this {
    this.data.timestamp = (date ?? new Date()).toISOString();
    return this;
  }

  setFooter(text: string, iconUrl?: string): this {
    if (text.length > 2048) throw new RangeError('Embed footer text exceeds 2048 characters');
    this.data.footer = { text, ...(iconUrl ? { iconUrl } : {}) };
    return this;
  }

  setAuthor(name: string, url?: string, iconUrl?: string): this {
    if (name.length > 256) throw new RangeError('Embed author name exceeds 256 characters');
    this.data.author = { name, ...(url ? { url } : {}), ...(iconUrl ? { iconUrl } : {}) };
    return this;
  }

  setThumbnail(url: string): this {
    this.data.thumbnail = { url };
    return this;
  }

  setImage(url: string): this {
    this.data.image = { url };
    return this;
  }

  addField(name: string, value: string, inline?: boolean): this {
    if (name.length > 256) throw new RangeError('Field name exceeds 256 characters');
    if (value.length > 1024) throw new RangeError('Field value exceeds 1024 characters');
    if (!this.data.fields) this.data.fields = [];
    if (this.data.fields.length >= 25) throw new RangeError('Embed cannot have more than 25 fields');
    this.data.fields.push({ name, value, ...(inline !== undefined ? { inline } : {}) });
    return this;
  }

  toJSON(): Embed {
    return { ...this.data };
  }
}
