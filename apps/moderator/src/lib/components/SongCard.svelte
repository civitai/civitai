<script lang="ts">
  import { browser } from '$app/environment';
  import { tick } from 'svelte';
  import {
    IconMusic,
    IconPlayerPauseFilled,
    IconPlayerPlayFilled,
    IconVolume,
  } from '@tabler/icons-svelte';
  import { Slider } from '@civitai/ui/components/ui/slider/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import EdgeImage from '$lib/components/EdgeImage.svelte';
  import { getEdgeUrl } from '$lib/media/edge-url';
  import { probeRetractedRefusal, RETRACTED_REFUSED, retractedMediaUrl } from '$lib/held-media';
  import { fetchJson } from '$lib/fetch-json';
  import { SSR_PENDING } from '$lib/ssr-pending';
  import { songCardUrl, type SongCard } from '$lib/music/song-card';
  import {
    createPlayIntent,
    formatSongTime,
    playSongAt,
    songPlayer,
    uniqueCardKey,
    type SongCardKey,
  } from '$lib/music/song-player';

  // A song in a moderator view: cover, play/pause, a seek bar with the time, the title and the lyrics.
  // Nothing plays until the moderator clicks; `song-player.ts` keeps one song playing at a time, at
  // the last volume. Like `CdnOrRetractedMedia`, the public CDN first, then storage through
  // `/api/retracted-media` for a song the CDN will not serve (a removed one).
  let {
    item,
    cardKey,
    class: className,
  }: {
    item: { id: number; url: string };
    /** Which card this is where the same song shows twice (the grid's item key); see `playSongAt`. */
    cardKey?: SongCardKey;
    class?: string;
  } = $props();

  const card = $derived(browser ? fetchJson<SongCard>(songCardUrl(item.id)) : SSR_PENDING);

  let audio = $state<HTMLAudioElement>();
  let paused = $state(true);
  let time = $state(0);
  let duration = $state(NaN);
  let volume = $state(1);

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
    if (audio) audio.currentTime = seconds;
  }

  function setVolume(value: number) {
    if (audio) audio.volume = value;
  }

  const length = $derived((knownLength: number | null) =>
    Number.isFinite(duration) && duration > 0 ? duration : (knownLength ?? 0)
  );
  const isSection = (text: string) => /^\s*\[[^\]]+\]\s*$/.test(text);
</script>

{#snippet player(song: SongCard | null, detailsFailed = false)}
  <div class={cn('flex h-full w-full flex-col gap-2 p-2 text-left', className)}>
    <div class="flex items-center gap-2">
      <div class="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-dark-6">
        {#if song?.cover}
          <EdgeImage src={song.cover.url} width={320} alt="" class="size-full object-cover" />
        {:else}
          <IconMusic size={28} class="text-dark-2" aria-label="No cover" />
        {/if}
      </div>
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-semibold" title={song?.title ?? undefined}>
          {song?.title || 'Untitled song'}
        </p>
        {#if mode === 'failed'}
          <p class="text-xs text-dark-2">{reason}</p>
        {:else}
          <p class="text-xs tabular-nums text-dark-2">
            {formatSongTime(time)} / {formatSongTime(length(song?.durationSec ?? null))}
          </p>
        {/if}
      </div>
      <button
        type="button"
        class="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-50"
        aria-label={paused ? 'Play' : 'Pause'}
        disabled={mode === 'failed'}
        onclick={toggle}
      >
        {#if paused}<IconPlayerPlayFilled size={16} />{:else}<IconPlayerPauseFilled size={16} />{/if}
      </button>
    </div>

    <Slider
      type="single"
      min={0}
      max={length(song?.durationSec ?? null) || 1}
      step={0.1}
      aria-label="Seek"
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
        class="max-w-24"
        bind:value={() => volume, setVolume}
      />
    </div>

    {#if song?.lines.length}
      <div class="min-h-0 flex-1 overflow-y-auto rounded-md bg-dark-7 p-2 text-xs leading-relaxed">
        {#each song.lines as line, i (i)}
          {#if isSection(line.text)}
            <p class="mt-1 text-[10px] font-semibold uppercase tracking-wide text-dark-2">{line.text}</p>
          {:else if line.t != null}
            {@const at = line.t / 1000}
            <button
              type="button"
              class="block w-full rounded px-1 text-left hover:bg-dark-5"
              title="Play from {formatSongTime(at)}"
              onclick={() => {
                intent.requested();
                playSongAt(item.id, at, ownKey);
              }}
            >
              {line.text}
            </button>
          {:else}
            <p class="px-1">{line.text}</p>
          {/if}
        {/each}
      </div>
    {:else if song}
      <p class="text-xs text-dark-2">No lyrics.</p>
    {:else if detailsFailed}
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
      bind:currentTime={time}
      bind:duration
      onplay={(e) => songPlayer.played(e.currentTarget)}
      onpause={(e) => {
        // The element a swap removed reports its pause late; only this card's current one counts.
        if (e.currentTarget === audio) intent.paused();
      }}
      onvolumechange={(e) => {
        volume = e.currentTarget.volume;
        songPlayer.volumeChanged(e.currentTarget);
      }}
      onerror={onError}
      {@attach register}
    ></audio>
  {/key}
{/if}

{#await card}
  {@render player(null)}
{:then song}
  {@render player(song)}
{:catch}
  {@render player(null, true)}
{/await}
