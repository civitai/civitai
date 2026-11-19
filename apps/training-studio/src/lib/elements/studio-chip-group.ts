import { css, html } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import { CivitaiElement, defineElement, hostBaseline } from '@civitai/components/internals';

export interface ChipItem {
  value: string;
  label: string;
  disabled?: boolean;
  /** Shown on hover; the reason a disabled chip can't be picked. */
  title?: string;
}

const TAG = 'studio-chip-group';
const NAV_KEYS = ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'];

/**
 * A single-select row of separate pills (Mantine `Chip` look), for choices that should read as a list of
 * options rather than one segmented control. Same contract as `civitai-segmented-control`: `data` is a
 * property, `value` the pick, `change` fires on a user pick.
 *
 * Label it with `aria-label`: `aria-labelledby` can't reach a light-DOM id from inside the shadow root.
 */
export class StudioChipGroup extends CivitaiElement {
  static styles = [
    hostBaseline,
    css`
      :host {
        display: block;
        min-width: 0;
      }
      .group {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      button {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 14px;
        border-radius: 999px;
        border: 1px solid var(--civitai-color-border);
        background: var(--civitai-color-surface);
        color: var(--civitai-color-text-dimmed);
        font: inherit;
        font-size: 14px;
        font-weight: 500;
        line-height: 1.25;
        cursor: pointer;
        transition: border-color 120ms, background-color 120ms, color 120ms;
      }
      button:hover:not(:disabled) {
        color: var(--civitai-color-text);
        border-color: var(--civitai-color-gray-6, var(--civitai-color-border));
      }
      button[aria-checked='true'] {
        border-color: var(--civitai-color-primary);
        background: color-mix(in srgb, var(--civitai-color-primary) 10%, transparent);
        color: var(--civitai-color-text);
        font-weight: 600;
      }
      button[aria-checked='true']::before {
        content: '';
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--civitai-color-primary);
      }
      button:focus-visible {
        outline: 2px solid var(--civitai-color-primary);
        outline-offset: 2px;
      }
      button:disabled {
        cursor: not-allowed;
        opacity: 0.4;
      }
    `,
  ];

  static properties = {
    data: { attribute: false },
    value: { reflect: true },
  };

  declare data: ChipItem[];
  declare value: string;

  constructor() {
    super();
    this.data = [];
    this.value = '';
  }

  get #enabled() {
    return this.data.filter((item) => !item.disabled);
  }

  #select(next: string, moveFocus: boolean) {
    if (next !== this.value) {
      this.value = next;
      this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }
    if (!moveFocus) return;
    void this.updateComplete.then(() => {
      this.renderRoot.querySelector<HTMLButtonElement>(`button[data-value="${next}"]`)?.focus();
    });
  }

  // Roving tabindex: arrows wrap across the enabled chips and selection follows focus, so the group is
  // one tab stop.
  #onKeyDown(event: KeyboardEvent) {
    const values = this.#enabled.map((item) => item.value);
    if (!NAV_KEYS.includes(event.key) || values.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, values.indexOf(this.value));
    const last = values.length - 1;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
        ? last
        : event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? (current + 1) % values.length
        : (current - 1 + values.length) % values.length;
    this.#select(values[next]!, true);
  }

  render() {
    const focusable = this.data.some((item) => item.value === this.value && !item.disabled)
      ? this.value
      : this.#enabled[0]?.value;
    return html`
      <div
        class="group"
        part="group"
        role="radiogroup"
        aria-label=${ifDefined(this.getAttribute('aria-label') ?? undefined)}
        @keydown=${this.#onKeyDown}
      >
        ${this.data.map(
          (item) => html`
            <button
              type="button"
              part="chip"
              data-value=${item.value}
              role="radio"
              aria-checked=${String(item.value === this.value)}
              tabindex=${item.value === focusable ? 0 : -1}
              title=${ifDefined(item.title)}
              ?disabled=${item.disabled ?? false}
              @click=${() => this.#select(item.value, false)}
            >
              ${item.label}
            </button>
          `
        )}
      </div>
    `;
  }
}

export function defineStudioChipGroup() {
  defineElement(TAG, StudioChipGroup);
}

declare global {
  interface HTMLElementTagNameMap {
    [TAG]: StudioChipGroup;
  }
}
