import { css, html } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import { CivitaiElement, defineElement, hostBaseline } from '@civitai/components/internals';

const TAG = 'studio-icon-button';

/**
 * An icon-only button in the main app's `ActionIcon` look (subtle gray, rounded square): the row and card
 * actions there are not the kit's pill-shaped `civitai-action-button`. The slotted icon is decorative, so
 * `label` is required: it is the button's accessible name, and its tooltip unless the host has a `title`. `color="error"` tints it for
 * a destructive action; `size` is `sm` (22px), `md` (28px, default) or `lg` (34px).
 *
 * Usable as a `civitai-menu` trigger: the menu writes `aria-haspopup`/`aria-expanded` on the host, and
 * they are mirrored onto the inner button, which is what a screen reader lands on.
 */
export class StudioIconButton extends CivitaiElement {
  static styles = [
    hostBaseline,
    css`
      :host {
        display: inline-flex;
        vertical-align: middle;
        --size: 28px;
        --tone: var(--civitai-color-text-dimmed);
        --tone-hover: var(--civitai-color-text);
      }
      :host([size='sm']) {
        --size: 22px;
      }
      :host([size='lg']) {
        --size: 34px;
      }
      :host([color='error']) {
        --tone-hover: var(--civitai-color-error);
      }
      button {
        display: inline-grid;
        place-items: center;
        width: var(--size);
        height: var(--size);
        padding: 0;
        border: 1px solid transparent;
        border-radius: var(--civitai-radius);
        background: transparent;
        color: var(--tone);
        cursor: pointer;
        transition: background-color 120ms ease, color 120ms ease;
      }
      button:hover:not(:disabled) {
        background: color-mix(in srgb, var(--tone-hover) 12%, transparent);
        color: var(--tone-hover);
      }
      button:focus-visible {
        outline: 2px solid var(--civitai-color-primary);
        outline-offset: 1px;
      }
      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      ::slotted(svg) {
        display: block;
      }
    `,
  ];

  static properties = {
    label: { reflect: true },
    size: { reflect: true },
    color: { reflect: true },
    disabled: { type: Boolean, reflect: true },
  };

  declare label: string;
  declare size: 'sm' | 'md' | 'lg';
  declare color: '' | 'error';
  declare disabled: boolean;

  constructor() {
    super();
    this.label = '';
    this.size = 'md';
    this.color = '';
    this.disabled = false;
    // A disabled custom element still receives clicks on its host; stop them before a consumer's handler.
    this.addEventListener(
      'click',
      (event) => {
        if (!this.disabled) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      { capture: true }
    );
  }

  #popupState = new MutationObserver(() => this.requestUpdate());

  override connectedCallback() {
    super.connectedCallback();
    this.#popupState.observe(this, {
      attributeFilter: ['aria-haspopup', 'aria-expanded', 'title'],
    });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.#popupState.disconnect();
  }

  override focus(options?: FocusOptions) {
    this.renderRoot.querySelector('button')?.focus(options);
  }

  render() {
    return html`
      <button
        type="button"
        part="button"
        aria-label=${this.label}
        aria-haspopup=${ifDefined(this.getAttribute('aria-haspopup') ?? undefined)}
        aria-expanded=${ifDefined(this.getAttribute('aria-expanded') ?? undefined)}
        title=${ifDefined(this.hasAttribute('title') ? undefined : this.label)}
        ?disabled=${this.disabled}
      >
        <slot></slot>
      </button>
    `;
  }
}

export function defineStudioIconButton() {
  defineElement(TAG, StudioIconButton);
}

declare global {
  interface HTMLElementTagNameMap {
    [TAG]: StudioIconButton;
  }
}
