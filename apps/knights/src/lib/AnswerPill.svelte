<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Icon from '$lib/Icon.svelte';

  /**
   * One answer in an answer row: equal width with its siblings, its number key, the hint on hover and focus, and the
   * pressed `picked` state held until the next item replaces it. Shared by the player game and the inquisitor queue.
   */
  let {
    option,
    index,
    picked = false,
    disabled = false,
    hint,
    yesNo = false,
    icon,
    keyHint,
    onclick,
  }: {
    option: { value: string; label: string };
    index: number;
    picked?: boolean;
    disabled?: boolean;
    hint?: string;
    /** A yes/no question: wider pills, a check or cross, and the key after the label. */
    yesNo?: boolean;
    /** Replaces the yes/no check or cross. */
    icon?: ComponentProps<typeof Icon>['name'];
    /** The key shown after the label, when it is not the option's number. */
    keyHint?: string;
    onclick?: HTMLButtonAttributes['onclick'];
  } = $props();

  const blocked = $derived(option.label.toLowerCase() === 'blocked');
  const yesNoIcon = $derived(icon ?? (yesNo ? (option.value === 'yes' ? 'check' : 'x') : null));
</script>

<button
  type="submit"
  class="pill"
  class:blocked
  class:picked
  class:yesno={yesNo}
  name="answer"
  value={option.value}
  title={hint}
  aria-label={blocked ? 'Blocked' : undefined}
  {disabled}
  {onclick}
>
  {#if yesNoIcon}<Icon name={yesNoIcon} />{/if}
  {#if blocked}<span class="ban"><Icon name="ban" size={20} /></span>{/if}
  <span class="level">{option.label}</span>
  <kbd class="key" aria-hidden="true">{keyHint ?? index + 1}</kbd>
</button>

<style>
  .pill {
    display: flex;
    flex: 1 1 0;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 0;
    height: 40px;
    padding: 0 8px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 6px;
    background: var(--io-bg);
    color: var(--io-parchment);
    font: 700 14px/1 var(--io-font-ui);
    transition:
      border-color var(--motion-fast) var(--ease-out-quart),
      background-color var(--motion-fast) var(--ease-out-quart),
      color var(--motion-fast) var(--ease-out-quart),
      box-shadow var(--motion-fast) var(--ease-out-quart),
      transform var(--motion-base) var(--ease-out-quart);
  }
  /* The design's M1: the answer presses in (0.97) and holds a gold ring until the next image replaces it. The answer is
     already submitted at the press; nothing here waits for the release. */
  .pill:active:not(:disabled),
  .pill.picked,
  .pill.picked:disabled {
    transform: scale(0.97);
    box-shadow:
      0 0 0 2px var(--io-gold),
      0 0 14px rgb(201 162 74 / 0.4);
    transition-duration: var(--motion-fast);
  }
  .pill.blocked.picked,
  .pill.blocked:active:not(:disabled) {
    box-shadow:
      0 0 0 2px var(--io-crimson-text),
      0 0 14px rgb(224 138 130 / 0.35);
  }
  @media (prefers-reduced-motion: reduce) {
    .pill,
    .pill:active:not(:disabled),
    .pill.picked,
    .pill.picked:disabled {
      transform: none;
      transition-duration: 120ms;
    }
  }
  .pill.yesno {
    padding: 0 16px;
  }
  .pill:hover:not(:disabled) {
    border-color: var(--io-gold);
    background: var(--io-bg);
  }
  .pill.picked,
  .pill.picked:disabled {
    border-color: var(--io-gold);
    background: var(--io-surface);
    color: var(--io-gold);
    opacity: 1;
  }
  .pill.blocked {
    border-color: var(--io-crimson);
    color: var(--io-crimson-text);
  }
  .pill.blocked:hover:not(:disabled) {
    border-color: var(--io-crimson-text);
  }
  .pill.blocked.picked {
    border-color: var(--io-crimson-text);
    color: var(--io-crimson-text);
  }
  .pill :global(svg) {
    flex: none;
  }
  /* A label never wraps: at mid widths the key chip gives way first (see below). */
  .level {
    white-space: nowrap;
  }
  .key {
    font-family: inherit;
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 6px;
    background: var(--io-bg);
    color: var(--io-parchment-muted);
    font: 700 12px/1 var(--io-font-ui);
    order: -1;
  }
  .yesno .key {
    order: 1;
    width: auto;
    background: none;
  }
  .picked .key {
    background: var(--io-bg);
    color: var(--io-parchment-muted);
  }
  .ban {
    display: none;
  }
  /* Up to 80rem the rating pills share the row with other controls: the chips go so every label fits. */
  @media (max-width: 80rem) {
    .pill:not(.yesno) .key {
      display: none;
    }
  }
  /* Touch and narrow screens: no key chips. */
  @media (max-width: 40rem), (hover: none) {
    .key {
      display: none;
    }
  }
  @media (max-width: 40rem) {
    .pill {
      min-height: 0;
      height: 40px;
      padding: 0 2px;
      font-size: 12px;
    }
    .pill.blocked .level {
      display: none;
    }
    .pill.blocked .ban {
      display: inline-flex;
    }
    .pill.yesno {
      font-size: 14px;
    }
  }
  @media (max-width: 22rem) {
    .pill {
      font-size: 11px;
    }
  }
</style>
