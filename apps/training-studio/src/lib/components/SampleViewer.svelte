<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { IconAlertTriangle, IconCheck } from '@tabler/icons-svelte';
  import { Spinner } from '@civitai/ui/components/ui/spinner/index.js';
  import type { TrainingDetailEpoch } from '$lib/data/trainingRows';

  let {
    epochs,
    prompts,
    isVideo,
    epochIndex: initialEpochIndex,
    sampleIndex: initialSampleIndex,
    onClose,
  }: {
    epochs: TrainingDetailEpoch[];
    prompts: string[];
    isVideo: boolean;
    epochIndex: number;
    sampleIndex: number;
    onClose: () => void;
  } = $props();

  // Unzoomed rendering is object-contain capped at natural size, so 2× the intrinsic pixels is always a
  // visible magnification and never interpolates a sample beyond double its real detail.
  const ZOOM_FACTOR = 2;

  // Seeded once from the opening cell; the viewer owns them thereafter and unmounts on close, so they
  // never need to react to the props.
  let epochIndex = $state(untrack(() => initialEpochIndex));
  let sampleIndex = $state(untrack(() => initialSampleIndex));
  let zoomed = $state(false);
  // Keyed by url rather than reset on navigation, so a cached sample whose load event beats a reset can't
  // have its measurement wiped and strand the viewer on the spinner.
  let loaded = $state<{ url: string; width: number; height: number } | null>(null);
  let erroredUrl = $state<string | null>(null);
  let paneEl = $state<HTMLDivElement>();
  let dialogEl = $state<HTMLDivElement>();
  let copied = $state(false);

  // Ref-like, deliberately non-reactive: the pan offset carried onto the next sample so holding ↑/↓ walks
  // the same magnified region through the epochs. Only honoured if the incoming sample measures the same.
  let carried: { left: number; top: number; width: number; height: number } | null = null;
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  const hasSampleAt = (epoch: TrainingDetailEpoch | undefined, index: number) =>
    !!epoch?.samples?.[index];

  const epoch = $derived(epochs[epochIndex]);
  const samples = $derived(epoch?.samples ?? []);
  const url = $derived(samples[sampleIndex] ?? null);
  const prompt = $derived(prompts[sampleIndex] ?? '');

  const natural = $derived(loaded && loaded.url === url ? loaded : null);
  const status = $derived(natural ? 'loaded' : erroredUrl === url ? 'error' : 'loading');

  // Epochs are laid out newest-first, so ↑ is a later epoch. Both axes skip past samples that were never
  // produced so navigation can never land on an empty frame.
  const findEpochWithSample = (step: number) => {
    for (let i = epochIndex + step; i >= 0 && i < epochs.length; i += step)
      if (hasSampleAt(epochs[i], sampleIndex)) return i;
    return undefined;
  };
  const findSampleInEpoch = (step: number) => {
    for (let i = sampleIndex + step; i >= 0 && i < samples.length; i += step)
      if (samples[i]) return i;
    return undefined;
  };

  const prevEpochIndex = $derived.by(() => findEpochWithSample(-1));
  const nextEpochIndex = $derived.by(() => findEpochWithSample(1));
  const prevSampleIndex = $derived.by(() => findSampleInEpoch(-1));
  const nextSampleIndex = $derived.by(() => findSampleInEpoch(1));

  const navigableCount = $derived(samples.filter(Boolean).length);
  const navigablePosition = $derived(samples.slice(0, sampleIndex + 1).filter(Boolean).length);

  const canZoom = $derived(!!natural);
  const zoomActive = $derived(zoomed && !!natural);

  function navigate(move: () => void) {
    const pane = paneEl;
    carried =
      pane && zoomed && natural
        ? { left: pane.scrollLeft, top: pane.scrollTop, width: natural.width, height: natural.height }
        : null;
    move();
  }
  const goSample = (index: number | undefined) =>
    index !== undefined && navigate(() => (sampleIndex = index));
  const goEpoch = (index: number | undefined) =>
    index !== undefined && navigate(() => (epochIndex = index));
  const toggleZoom = () => canZoom && (zoomed = !zoomed);

  // Restore (or centre) the pan once the incoming sample has been measured — scrollWidth already reflects
  // its zoomed size, so restoring any earlier would clamp to 0 and lose the offset.
  $effect(() => {
    const pane = paneEl;
    if (!pane) return;
    if (!zoomed) {
      carried = null;
      pane.scrollTo(0, 0);
      return;
    }
    const dims = loaded && loaded.url === url ? loaded : null;
    if (!dims) return;

    const c = carried;
    carried = null;
    if (c && c.width === dims.width && c.height === dims.height) {
      pane.scrollLeft = c.left;
      pane.scrollTop = c.top;
    } else {
      pane.scrollLeft = (pane.scrollWidth - pane.clientWidth) / 2;
      pane.scrollTop = (pane.scrollHeight - pane.clientHeight) / 2;
    }
  });

  // Sample media is removed 30 days after a run completes; if the opening cell is already gone, close
  // rather than sit on a spinner.
  $effect(() => {
    if (!epoch || !url) onClose();
  });

  $effect(() => () => clearTimeout(copyTimer));

  // Move focus into the fullscreen dialog on open (so Tab/Escape act on it, not the obscured page) and
  // restore it to the thumbnail that launched it on close.
  onMount(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogEl?.focus();
    return () => previouslyFocused?.focus?.();
  });

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard blocked (insecure context / denied) — nothing actionable to show.
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Tab' && dialogEl) {
      const focusables = [...dialogEl.querySelectorAll<HTMLElement>('button:not([disabled])')].filter(
        (el) => el.offsetParent !== null
      );
      if (focusables.length) {
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        } else if (!dialogEl.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
      return;
    }
    switch (e.key) {
      case 'Escape':
        onClose();
        break;
      case 'ArrowLeft':
        if (prevSampleIndex !== undefined) {
          e.preventDefault();
          goSample(prevSampleIndex);
        }
        break;
      case 'ArrowRight':
        if (nextSampleIndex !== undefined) {
          e.preventDefault();
          goSample(nextSampleIndex);
        }
        break;
      case 'ArrowUp':
        if (prevEpochIndex !== undefined) {
          e.preventDefault();
          goEpoch(prevEpochIndex);
        }
        break;
      case 'ArrowDown':
        if (nextEpochIndex !== undefined) {
          e.preventDefault();
          goEpoch(nextEpochIndex);
        }
        break;
    }
  }

  const CHEVRON = {
    left: 'M15 18l-6-6 6-6',
    right: 'M9 6l6 6-6 6',
    up: 'M6 15l6-6 6 6',
    down: 'M6 9l6 6 6-6',
  };

  const mediaClass = $derived(
    [
      'transition-opacity',
      status === 'loaded' ? 'opacity-100' : 'opacity-0',
      zoomActive ? 'm-auto max-w-none shrink-0' : 'max-h-full max-w-full object-contain',
    ].join(' ')
  );
  const zoomStyle = $derived(
    zoomActive ? `width:${natural!.width * ZOOM_FACTOR}px;height:${natural!.height * ZOOM_FACTOR}px` : ''
  );
</script>

<svelte:window onkeydown={onKeydown} />

{#if epoch && url}
  <div
    bind:this={dialogEl}
    class="fixed inset-0 z-50 flex flex-col bg-dark-9/95 p-4 backdrop-blur-md"
    role="dialog"
    aria-modal="true"
    aria-label="Sample viewer"
    tabindex="-1"
  >
    <div class="mb-3 flex items-center gap-3">
      <span class="rounded bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground">
        Epoch {epoch.number}
      </span>
      <span class="font-mono text-xs text-dark-2">
        sample {navigablePosition} of {navigableCount}
      </span>
      <div class="ml-auto flex items-center gap-1.5">
        {#if canZoom}
          <button
            type="button"
            onclick={toggleZoom}
            aria-label={zoomed ? 'Fit to screen' : `Magnify ${ZOOM_FACTOR}×`}
            title={zoomed ? 'Fit to screen' : `Magnify ${ZOOM_FACTOR}×`}
            class="grid h-9 w-9 place-items-center rounded-md text-dark-0 transition-colors hover:bg-dark-5"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="h-5 w-5"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="8" y1="11" x2="14" y2="11" />
              {#if !zoomed}<line x1="11" y1="8" x2="11" y2="14" />{/if}
            </svg>
          </button>
        {/if}
        <button
          type="button"
          onclick={onClose}
          aria-label="Close sample viewer"
          title="Close (Esc)"
          class="grid h-9 w-9 place-items-center rounded-md text-dark-0 transition-colors hover:bg-dark-5"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="h-5 w-5"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>

    <div class="relative flex min-h-0 flex-1">
      <div
        bind:this={paneEl}
        class="flex flex-1 {zoomActive
          ? 'overflow-auto'
          : 'items-center justify-center overflow-hidden'}"
      >
        {#if status === 'loading'}
          <div class="absolute inset-0 grid place-items-center">
            <Spinner class="size-8 text-dark-2" />
          </div>
        {:else if status === 'error'}
          <div class="absolute inset-0 grid place-items-center px-6 text-center">
            <div>
              <IconAlertTriangle size={30} stroke={2} class="mx-auto text-dark-2" />
              <p class="mt-2 text-sm text-white">This sample could not be loaded.</p>
              <p class="mt-1 text-xs text-dark-2">
                Sample media is removed 30 days after training completes.
              </p>
            </div>
          </div>
        {/if}

        {#key url}
          {#if isVideo}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video
              src={url}
              loop
              playsinline
              muted
              autoplay
              controls
              class={mediaClass}
              style={zoomStyle}
              onloadeddata={(e) => {
                const el = e.currentTarget as HTMLVideoElement;
                if (el.videoWidth && el.videoHeight)
                  loaded = { url, width: el.videoWidth, height: el.videoHeight };
              }}
              onerror={() => (erroredUrl = url)}
            ></video>
          {:else}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <img
              src={url}
              alt="Epoch {epoch.number} sample {navigablePosition}"
              class="{mediaClass} {canZoom ? (zoomed ? 'cursor-zoom-out' : 'cursor-zoom-in') : ''}"
              style={zoomStyle}
              onclick={toggleZoom}
              onload={(e) => {
                const el = e.currentTarget as HTMLImageElement;
                if (el.naturalWidth && el.naturalHeight)
                  loaded = { url, width: el.naturalWidth, height: el.naturalHeight };
              }}
              onerror={() => (erroredUrl = url)}
            />
          {/if}
        {/key}
      </div>

      {@render navBtn('left', 'left-2 top-1/2 -translate-y-1/2', prevSampleIndex === undefined, prevSampleIndex !== undefined ? 'Previous sample (←)' : 'No earlier sample in this epoch', () => goSample(prevSampleIndex))}
      {@render navBtn('right', 'right-2 top-1/2 -translate-y-1/2', nextSampleIndex === undefined, nextSampleIndex !== undefined ? 'Next sample (→)' : 'No later sample in this epoch', () => goSample(nextSampleIndex))}
      {@render navBtn('up', 'left-1/2 top-2 -translate-x-1/2', prevEpochIndex === undefined, prevEpochIndex !== undefined ? `Same sample in epoch ${epochs[prevEpochIndex].number} (↑)` : 'No later epoch with this sample', () => goEpoch(prevEpochIndex))}
      {@render navBtn('down', 'bottom-2 left-1/2 -translate-x-1/2', nextEpochIndex === undefined, nextEpochIndex !== undefined ? `Same sample in epoch ${epochs[nextEpochIndex].number} (↓)` : 'No earlier epoch with this sample', () => goEpoch(nextEpochIndex))}
    </div>

    <div class="mt-3 flex items-start gap-2">
      <span class="shrink-0 font-mono text-xs text-dark-2">Prompt</span>
      <p class="m-0 flex-1 whitespace-pre-wrap break-words text-sm text-dark-0">
        {prompt.trim().length ? prompt : '(no prompt provided)'}
      </p>
      {#if prompt.trim().length}
        <button
          type="button"
          onclick={copyPrompt}
          aria-label={copied ? 'Copied' : 'Copy prompt'}
          title={copied ? 'Copied' : 'Copy prompt'}
          class="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 font-mono text-xs text-dark-2 transition-colors hover:bg-dark-5 hover:text-white"
        >
          {#if copied}<IconCheck size={12} stroke={2.5} />Copied{:else}Copy{/if}
        </button>
      {/if}
    </div>
  </div>
{/if}

{#snippet navBtn(
  dir: keyof typeof CHEVRON,
  positionCls: string,
  disabled: boolean,
  label: string,
  onclick: () => void
)}
  <button
    type="button"
    {onclick}
    {disabled}
    aria-label={label}
    title={label}
    class="absolute z-10 grid h-11 w-11 place-items-center rounded-full bg-dark-6/80 text-white opacity-80 transition hover:opacity-100 disabled:pointer-events-none disabled:opacity-20 {positionCls}"
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="h-6 w-6"
    >
      <path d={CHEVRON[dir]} />
    </svg>
  </button>
{/snippet}
