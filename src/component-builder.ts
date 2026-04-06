import type { ActionRow, Button, SelectMenu, SelectOption } from './types.js';

export class ActionRowBuilder {
  private components: (Button | SelectMenu)[] = [];

  addButton(button: Button | ButtonBuilder): this {
    const b = button instanceof ButtonBuilder ? button.toJSON() : button;
    if (this.components.length >= 5) throw new RangeError('ActionRow cannot have more than 5 components');
    this.components.push(b);
    return this;
  }

  addSelect(select: SelectMenu | SelectMenuBuilder): this {
    const s = select instanceof SelectMenuBuilder ? select.toJSON() : select;
    this.components.push(s);
    return this;
  }

  toJSON(): ActionRow {
    return { type: 'actionRow', components: [...this.components] };
  }
}

export class ButtonBuilder {
  private data: Partial<Button> = { type: 'button' };

  setLabel(label: string): this {
    if (label.length > 80) throw new RangeError('Button label exceeds 80 characters');
    this.data.label = label;
    return this;
  }

  setStyle(style: Button['style']): this {
    this.data.style = style;
    return this;
  }

  setCustomId(id: string): this {
    if (id.length > 100) throw new RangeError('customId exceeds 100 characters');
    this.data.customId = id;
    return this;
  }

  setURL(url: string): this {
    this.data.url = url;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.data.disabled = disabled;
    return this;
  }

  setEmoji(emoji: string): this {
    this.data.emoji = emoji;
    return this;
  }

  setMetadata(data: Record<string, unknown>): this {
    this.data.metadata = data;
    return this;
  }

  toJSON(): Button {
    if (!this.data.label) throw new Error('Button must have a label');
    if (!this.data.style) throw new Error('Button must have a style');
    return { ...this.data } as Button;
  }
}

export class SelectMenuBuilder {
  private data: Partial<SelectMenu> & { options: SelectOption[] } = { type: 'select', options: [] };

  setCustomId(id: string): this {
    if (id.length > 100) throw new RangeError('customId exceeds 100 characters');
    this.data.customId = id;
    return this;
  }

  setPlaceholder(text: string): this {
    if (text.length > 150) throw new RangeError('Placeholder exceeds 150 characters');
    this.data.placeholder = text;
    return this;
  }

  addOption(option: SelectOption): this {
    if (this.data.options.length >= 25) throw new RangeError('SelectMenu cannot have more than 25 options');
    this.data.options.push(option);
    return this;
  }

  setMinValues(n: number): this {
    this.data.minValues = n;
    return this;
  }

  setMaxValues(n: number): this {
    this.data.maxValues = n;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.data.disabled = disabled;
    return this;
  }

  setMetadata(data: Record<string, unknown>): this {
    this.data.metadata = data;
    return this;
  }

  toJSON(): SelectMenu {
    if (!this.data.customId) throw new Error('SelectMenu must have a customId');
    return { ...this.data } as SelectMenu;
  }
}
