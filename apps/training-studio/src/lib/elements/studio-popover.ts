import { css, html } from 'lit';
import { CivitaiElement, defineElement, hostBaseline } from '@civitai/components/internals';

const TAG = 'studio-popover';
const GAP = 6;
const EDGE = 8;

/**
 * A click-to-open panel under a trigger (the kit has no popover). The panel is a native `popover`, so it
 * sits in the top layer, closes on an outside click or Escape, and no ancestor's overflow clips it, which
 * matters in the main-app embed. Put the trigger button in `slot="trigger"` and the panel content in the
 * default slot. `open` is a property; `toggle` fires when the panel opens or closes.
 */
export class StudioPopover extends CivitaiElement {
  static styles = [
    hostBaseline,
    css`
      :host {
        display: inline-block;
      }
      [popover] {
        position: fixed;
        inset: auto;
        margin: 0;
        min-width: 200px;
        max-width: min(320px, calc(100vw - 16px));
        padding: 12px;
        border: 1px solid var(--civitai-color-border);
        border-radius: var(--civitai-radius);
        background: var(--civitai-color-surface);
        color: var(--civitai-color-text);
        font-family: var(--civitai-font);
        box-shadow: 0 8px 24px rgb(0 0 0 / 0.4);
      }
    `,
  ];

  static properties = {
    open: { type: Boolean, reflect: true },
  };

  declare open: boolean;

  constructor() {
    super();
    this.open = false;
  }

  get #panel() {
    return this.renderRoot.querySelector<HTMLElement>('[popover]');
  }

  get #trigger() {
    return this.renderRoot
      .querySelector<HTMLSlotElement>('slot[name="trigger"]')
      ?.assignedElements()[0] as HTMLElement | undefined;
  }

  #place = () => {
    const panel = this.#panel;
    const trigger = this.#trigger;
    if (!panel || !trigger) return;
    const anchor = trigger.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const below = anchor.bottom + GAP;
    const top =
      below + height > window.innerHeight - EDGE && anchor.top - GAP - height > EDGE
        ? anchor.top - GAP - height
        : below;
    const left = Math.min(Math.max(EDGE, anchor.left), window.innerWidth - width - EDGE);
    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
  };

  #onToggle = (event: Event) => {
    const opened = (event as ToggleEvent).newState === 'open';
    if (opened) {
      this.#place();
      window.addEventListener('scroll', this.#place, true);
      window.addEventListener('resize', this.#place);
    } else {
      window.removeEventListener('scroll', this.#place, true);
      window.removeEventListener('resize', this.#place);
    }
    if (this.open !== opened) {
      this.open = opened;
      this.dispatchEvent(new Event('toggle'));
    }
  };

  // A pointer press on the trigger light-dismisses an open panel before the click lands, so a pointer
  // click decides from the state at press time; otherwise it would reopen what it just closed. A
  // keyboard click (`detail` 0) has no press and decides from the current state.
  #openAtPress = false;

  #onTriggerPointerDown = () => {
    this.#openAtPress = this.open;
  };

  #onTriggerClick = (event: MouseEvent) => {
    const wasOpen = event.detail === 0 ? this.open : this.#openAtPress;
    this.open = !wasOpen;
    this.#openAtPress = false;
    this.dispatchEvent(new Event('toggle'));
  };

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('scroll', this.#place, true);
    window.removeEventListener('resize', this.#place);
  }

  updated() {
    const panel = this.#panel;
    if (panel) {
      const shown = panel.matches(':popover-open');
      if (this.open && !shown) panel.showPopover();
      else if (!this.open && shown) panel.hidePopover();
    }
    const trigger = this.#trigger;
    trigger?.setAttribute('aria-haspopup', 'dialog');
    trigger?.setAttribute('aria-expanded', String(this.open));
  }

  render() {
    return html`
      <span part="trigger" @pointerdown=${this.#onTriggerPointerDown} @click=${this.#onTriggerClick}
        ><slot name="trigger"></slot
      ></span>
      <div popover="auto" part="panel" role="dialog" @toggle=${this.#onToggle}><slot></slot></div>
    `;
  }
}

export function defineStudioPopover() {
  defineElement(TAG, StudioPopover);
}

declare global {
  interface HTMLElementTagNameMap {
    [TAG]: StudioPopover;
  }
}
