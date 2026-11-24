<script lang="ts">
  import { browser } from '$app/environment';
  import { tick } from 'svelte';
  import {
    IconLoader2,
    IconMusic,
    IconPlayerPauseFilled,
    IconPlayerPlayFilled,
    IconVolume,
  } from '@tabler/icons-svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Slider } from '@civitai/ui/components/ui/slider/index.js';
  import { formatPlaybackTime } from '@civitai/shared';
  import { cn } from '@civitai/ui/utils.js';
  import EdgeImage from '$lib/components/EdgeImage.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { getEdgeUrl } from '$lib/media/edge-url';
  import { probeRetractedRefusal, RETRACTED_REFUSED, retractedMediaUrl } from '$lib/held-media';
  import { fetchJson } from '$lib/fetch-json';
  import { SSR_PENDING } from '$lib/ssr-pending';
  import { songCardUrl, type SongCard } from '$lib/music/song-card';
  import {
    createPlayIntent,
    isSeek,
    playSongAt,
    songLoading,
    songPlayer,
    uniqueCardKey,
    type SongLoadEvent,
    type SongCardKey,
  } from '$lib/music/song-player';

  // A song in a moderator view: cover, play/pause, a seek bar with the time, the title and the lyrics.
  // Nothing plays until the moderator clicks; `song-player.ts` keeps one song playing at a time, at
  // the last volume. Like `CdnOrRetractedMedia`, the public CDN first, then storage through
  // `/api/retracted-media` for a song the CDN will not serve (a removed one).
  //
  // One instance plays one song: its time, length and play state are the instance's, so a caller that
  // swaps `item` on the same instance (Image lookup) wraps the card in `{#key item.id}`.
  let {
    item,
    cardKey,
    variant = 'card',
    class: className,
  }: {
    item: { id: number; url: string };
    /** Which card this is where the same song shows twice (the grid's item key); see `playSongAt`. */
    cardKey?: SongCardKey;
    /** `card` fits a queue tile, its lyrics scrolling inside it. `detail` is a triage pane's middle
     *  column: the player and the lyrics as two panels at reading size, the column scrolling. */
    variant?: 'card' | 'detail';
    class?: string;
  } = $props();
  const detail = $derived(variant === 'detail');
  const PANEL = 'rounded-lg border border-dark-4 bg-dark-7 p-3.5';

  const card = $derived(browser ? fetchJson<SongCard>(songCardUrl(item.id)) : SSR_PENDING);

  let audio = $state<HTMLAudioElement>();
  let paused = $state(true);
  let time = $state(0);
  let duration = $state(NaN);
  let volume = $state(1);
  // From a play until the song can play: a removed song from storage starts loading only then.
  let loading = $state(false);
  const loadEvent = (event: SongLoadEvent) => (loading = songLoading(loading, event));

  // Per id, so an instance reused for another song starts on the CDN again.
  let fallback = $state<{ id: number; mode: 'retracted' | 'failed' } | null>(null);
  const mode = $derived(fallback?.id === item.id ? fallback.mode : 'cdn');
  let reason = $state(RETRACTED_REFUSED);
  // A song playing when the CDN refused it goes on from the stored copy; a paused one stays paused.
  const intent = createPlayIntent();
  // The key this card registers under and its own controls target, so they never drive another card
  // showing the same song.
  const fallbackKey = uniqueCardKey();
  const ownKey = $derived(cardKey ?? fallbackKey);

  const src = $derived(
    mode === 'cdn' ? getEdgeUrl(item.url, { type: 'audio' }) : retractedMediaUrl(item.id)
  );

  function register(el: HTMLAudioElement) {
    const unregister = songPlayer.register(item.id, el, ownKey);
    volume = el.volume;
    return unregister;
  }

  async function onError() {
    const id = item.id;
    if (mode === 'cdn') {
      const resume = intent.resumeAfterSwap();
      fallback = { id, mode: 'retracted' };
      if (!resume) return;
      await tick();
      intent.requested();
      audio?.play().catch(() => undefined);
      return;
    }
    fallback = { id, mode: 'failed' };
    reason = RETRACTED_REFUSED;
    probeRetractedRefusal(id)
      .then((line) => {
        if (fallback?.id === id) reason = line;
      })
      .catch(() => null);
  }

  function toggle() {
    if (!audio) return;
    if (audio.paused) {
      intent.requested();
      audio.play().catch(() => undefined);
    } else audio.pause();
  }

  function seek(seconds: number) {
    if (audio && isSeek(seconds, audio.currentTime)) audio.currentTime = seconds;
  }

  function setVolume(value: number) {
    if (audio) audio.volume = value;
  }

  /** The file's own length once it has loaded, else the upload's. */
  function lengthOf(song: SongCard | null) {
    return Number.isFinite(duration) && duration > 0 ? duration : (song?.durationSec ?? 0);
  }
  const isSection = (text: string) => /^\s*\[[^\]]+\]\s*$/.test(text);
</script>

{#snippet lyrics(lines: SongCard['lines'])}
  {#each lines as line, i (i)}
    {#if isSection(line.text)}
      <p class="mt-1 text-xs font-semibold uppercase tracking-wide text-dark-2">{line.text}</p>
    {:else if line.t != null}
      {@const at = line.t / 1000}
      <button
        type="button"
        class={cn(
          'flex w-full items-baseline text-left hover:bg-dark-5',
          detail ? 'gap-2 rounded-md px-2 py-1.5' : 'min-h-6 gap-2 rounded px-1 py-0.5'
        )}
        title="Play from {formatPlaybackTime(at)}"
        onclick={() => {
          intent.requested();
          playSongAt(item.id, at, ownKey);
        }}
      >
        <span
          class={cn(
            'shrink-0 tabular-nums text-dark-2',
            detail && 'w-[34px] text-xs font-semibold'
          )}>{formatPlaybackTime(at)}</span
        >
        <span>{line.text}</span>
      </button>
    {:else}
      <p class={detail ? 'm-0 px-2 py-1.5' : 'px-1'}>{line.text}</p>
    {/if}
  {/each}
{/snippet}

<!-- `phase`: the card's details are loading, came back, or could not be read (the song still plays). -->
{#snippet player(song: SongCard | null, phase: 'loading' | 'loaded' | 'failed')}
  <div
    class={cn(
      'flex w-full flex-col text-left',
      detail ? 'gap-3' : 'h-full gap-2 p-2',
      className
    )}
  >
    <div class={cn('flex flex-col gap-2', detail && PANEL)}>
      <div class="flex items-center gap-2">
        <div class="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-dark-6">
          {#if song?.cover}
            <EdgeImage src={song.cover.url} width={320} alt="" class="size-full object-cover" />
          {:else}
            <IconMusic size={28} class="text-dark-2" aria-label="No cover" />
          {/if}
        </div>
        <div class="min-w-0 flex-1">
          <p
            class={cn('truncate font-semibold', detail ? 'text-[15px] text-white' : 'text-sm text-dark-0')}
            title={song?.title ?? undefined}
          >
            {#if phase === 'loading'}
              Loading song…
            {:else if phase === 'failed'}
              Song #{item.id}
            {:else}
              {song?.title || 'Untitled song'}
            {/if}
          </p>
            {#if mode === 'failed'}
            <p class="text-xs text-dark-2">{reason}</p>
          {:else}
            <p class="text-xs tabular-nums text-dark-2">
              {formatPlaybackTime(time)} / {formatPlaybackTime(lengthOf(song))}
            </p>
          {/if}
        </div>
        <Button
          size="icon-lg"
          class="shrink-0 rounded-full"
          aria-label={loading ? 'Loading' : paused ? 'Play' : 'Pause'}
          aria-busy={loading}
          disabled={mode === 'failed'}
          onclick={toggle}
        >
          {#if loading}
            <IconLoader2 size={16} class="animate-spin" />
          {:else if paused}
            <IconPlayerPlayFilled size={16} />
          {:else}
            <IconPlayerPauseFilled size={16} />
          {/if}
        </Button>
      </div>

      <Slider
        type="single"
        min={0}
        max={lengthOf(song) || 1}
        step={0.1}
        aria-label="Seek"
        class="h-6"
        trackClass="bg-dark-4"
        disabled={mode === 'failed'}
        bind:value={() => time, seek}
      />
      <div class="flex items-center gap-2">
        <IconVolume size={14} class="shrink-0 text-dark-2" aria-hidden="true" />
        <Slider
          type="single"
          min={0}
          max={1}
          step={0.05}
          aria-label="Volume"
          class="h-6 max-w-24"
          trackClass="bg-dark-4"
          bind:value={() => volume, setVolume}
        />
      </div>
    </div>

    {#if song?.lines.length}
      {#if detail}
        <TriageCard title="Lyrics · click a line to seek" dense>
          <div class="text-sm leading-snug">{@render lyrics(song.lines)}</div>
        </TriageCard>
      {:else}
        <div
          class="min-h-0 flex-1 overflow-y-auto rounded-md bg-dark-7 p-2 text-xs leading-relaxed"
        >
          {@render lyrics(song.lines)}
        </div>
      {/if}
    {:else if song}
      <p class="text-xs text-dark-2">No lyrics.</p>
    {:else if phase === 'failed'}
      <!-- The song still plays; only its title, cover and lyrics are missing. -->
      <p class="text-xs text-dark-2">Couldn't load this song's cover and lyrics.</p>
    {/if}
  </div>
{/snippet}

<!-- Client-only, so a failed load cannot fire before the error handler is attached. -->
{#if browser}
  {#key `${item.id}:${mode}`}
    <!-- From storage, nothing loads until play: every response from that route is an audit row. -->
    <audio
      {src}
      preload={mode === 'cdn' ? 'metadata' : 'none'}
      bind:this={audio}
      bind:paused
      ontimeupdate={(e) => (time = e.currentTarget.currentTime)}
      bind:duration
      onplay={(e) => {
        loadEvent('play');
        songPlayer.played(e.currentTarget);
      }}
      onpause={(e) => {
        // The element a swap removed reports its pause late; only this card's current one counts.
        if (e.currentTarget !== audio) return;
        loadEvent('pause');
        intent.paused();
      }}
      onwaiting={() => loadEvent('waiting')}
      onplaying={() => loadEvent('playing')}
      oncanplay={() => loadEvent('canplay')}
      onvolumechange={(e) => {
        volume = e.currentTarget.volume;
        songPlayer.volumeChanged(e.currentTarget);
      }}
      onerror={() => {
        loadEvent('error');
        void onError();
      }}
      {@attach register}
    ></audio>
  {/key}
{/if}

{#await card}
  {@render player(null, 'loading')}
{:then song}
  {@render player(song, 'loaded')}
{:catch}
  {@render player(null, 'failed')}
{/await}
