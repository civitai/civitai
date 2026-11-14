<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  let {
    id,
    label,
    trigger,
    children,
  }: {
    id: string;
    /** Names the button and the popover. */
    label: string;
    trigger: Snippet;
    children: Snippet;
  } = $props();

  // Desktop: hover and keyboard focus open it, a click pins it, Escape or an outside click closes it. Touch: a tap opens a bottom
  // sheet. `pinned` keeps a click-opened popover from closing when the pointer leaves.
  let open = $state(false);
  let pinned = $state(false);
  let wrapper = $state<HTMLElement>();
  let button = $state<HTMLButtonElement>();
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;

  const hovers = () => matchMedia('(hover: hover) and (pointer: fine)').matches;

  function show() {
    clearTimeout(leaveTimer);
    open = true;
  }
  function hide(returnFocus = false) {
    clearTimeout(leaveTimer);
    open = false;
    pinned = false;
    if (returnFocus) button?.focus();
  }

  function onpointerenter() {
    if (hovers()) show();
  }
  function onpointerleave() {
    if (!hovers() || pinned) return;
    leaveTimer = setTimeout(() => (open = false), 140);
  }
  function onclick() {
    if (open && pinned) return hide();
    show();
    pinned = true;
  }
  function onfocusin() {
    // Only keyboard focus opens it; a click's focus is handled by the click itself.
    if (button?.matches(':focus-visible')) show();
  }
  function onfocusout(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (open && !wrapper?.contains(next)) hide();
  }
  function onkeydown(event: KeyboardEvent) {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      hide(true);
    }
  }
  function onwindowpointerdown(event: PointerEvent) {
    if (open && !wrapper?.contains(event.target as Node)) hide();
  }
</script>

<svelte:window onpointerdown={onwindowpointerdown} />

<div
  class="stat"
  bind:this={wrapper}
  {onpointerenter}
  {onpointerleave}
  {onfocusin}
  {onfocusout}
  {onkeydown}
  role="presentation"
>
  <button
    type="button"
    class="pill"
    aria-expanded={open}
    aria-controls={id}
    aria-haspopup="dialog"
    aria-label={label}
    bind:this={button}
    {onclick}
  >
    {@render trigger()}
    <span class="chev" class:flip={open}><Icon name="chevron-down" size={14} /></span>
  </button>

  {#if open}
    <button type="button" class="scrim" tabindex="-1" aria-hidden="true" onclick={() => hide(true)}></button>
    <div class="panel" {id} role="dialog" aria-label={label}>
      <div class="card">
        <button type="button" class="close" aria-label="Close" onclick={() => hide(true)}>
          <Icon name="x" size={18} />
        </button>
        {@render children()}
      </div>
    </div>
  {/if}
</div>

<style>
  .stat {
    position: relative;
  }
  .pill {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 0;
    padding: 5px 10px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 999px;
    background: var(--io-bg);
    color: var(--io-parchment);
    font: 600 13px/1.2 var(--io-font-ui);
    white-space: nowrap;
  }
  .pill:hover:not(:disabled),
  .pill[aria-expanded='true'] {
    border-color: var(--io-gold);
    background: var(--io-bg);
  }
  .chev {
    display: inline-flex;
    color: var(--io-parchment-muted);
    transition: transform var(--motion-base) var(--ease-out-quart);
  }
  .chev.flip {
    transform: rotate(180deg);
  }
  /* The hover bridge: the panel starts flush with the pill and pads its own top, so the pointer never crosses a gap. */
  .panel {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 22;
    padding-top: 8px;
    animation: pop var(--motion-base) var(--ease-out-quart);
  }
  .card {
    position: relative;
    width: max-content;
    min-width: 288px;
    max-width: 320px;
    padding: 16px;
    border: 1px solid var(--io-gold);
    border-radius: 12px;
    background: var(--io-surface);
    box-shadow: 0 12px 32px #000000aa;
    font-family: var(--io-font-ui);
  }
  .scrim,
  .close {
    display: none;
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .chev {
      transition: none;
    }
  }

  @media (max-width: 40rem) {
    .pill {
      gap: 5px;
      padding: 4px 8px;
      font-size: 12px;
    }
    .chev {
      display: none;
    }
    .scrim {
      position: fixed;
      inset: 0;
      z-index: 20;
      display: block;
      min-height: 0;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: #14110dd9;
    }
    .scrim:hover:not(:disabled) {
      background: #14110dd9;
    }
    .panel {
      position: fixed;
      top: auto;
      right: 0;
      bottom: 0;
      left: 0;
      padding: 0;
      animation: sheet var(--motion-base) var(--ease-out-quart);
    }
    .card {
      width: auto;
      max-width: none;
      max-height: 85dvh;
      overflow-y: auto;
      padding: 20px 20px max(20px, env(safe-area-inset-bottom));
      border-width: 1px 0 0;
      border-radius: 16px 16px 0 0;
    }
    .close {
      position: absolute;
      top: 8px;
      right: 8px;
      display: grid;
      place-items: center;
      width: 44px;
      min-height: 44px;
      padding: 0;
      border: 0;
      background: none;
      color: var(--io-parchment-muted);
    }
    @keyframes sheet {
      from {
        transform: translateY(24px);
        opacity: 0;
      }
    }
  }
</style>
