<script lang="ts">
  import { heldMediaUrl } from '$lib/held-media';

  // From storage through `/api/held-media`, never the public CDN. No download fallback: a file that
  // cannot be shown inline is described instead.
  let {
    item,
    class: className,
  }: {
    item: {
      id: number;
      type: string;
      mimeType?: string | null;
      size?: string | null;
      duration?: string | null;
    };
    class?: string;
  } = $props();

  let failed = $state(false);

  const megabytes = (size: string | null | undefined) => {
    const n = Number(size);
    return size && Number.isFinite(n) ? `${(n / 1_048_576).toFixed(1)} MB` : null;
  };
  const seconds = (duration: string | null | undefined) => {
    const n = Number(duration);
    return duration && Number.isFinite(n) ? `${Math.round(n)} s` : null;
  };
</script>

{#if failed}
  <div class="flex flex-col items-center gap-1 p-4 text-center text-xs text-dark-2">
    <span>{item.type === 'video' ? 'This video does not play in a browser.' : 'Could not load this file.'}</span>
    <span>
      {[item.mimeType ?? 'unknown type', megabytes(item.size), seconds(item.duration)]
        .filter(Boolean)
        .join(' · ')}
    </span>
  </div>
{:else if item.type === 'video'}
  <video
    src={heldMediaUrl(item.id)}
    class={className}
    muted
    playsinline
    preload="metadata"
    onerror={() => (failed = true)}
  ></video>
{:else}
  <img
    src={heldMediaUrl(item.id)}
    alt=""
    loading="lazy"
    decoding="async"
    class={className}
    onerror={() => (failed = true)}
  />
{/if}
