<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { getEdgeUrl } from '$lib/media/edge-url';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const filters = [
    { id: 'flagged', label: 'Flagged, unreviewed' },
    { id: 'all', label: 'All scans' },
    { id: 'failed', label: 'Errors' },
    { id: 'reviewed', label: 'Reviewed' },
  ];
</script>

<svelte:head><title>Audio review</title></svelte:head>

<div class="space-y-5 p-5">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold text-white">Audio review</h1>
      <p class="mt-2 text-dark-2">Speech and lyrics from uploaded video and music. Shadow reviews record whether you would block for sexualized minors. They do not remove posts.</p>
    </div>
    <Button href="/audio-review/export" variant="outline">Export last 14 days</Button>
  </div>
  <nav class="flex flex-wrap gap-2" aria-label="Audio scan filters">
    {#each filters as filter (filter.id)}
      <Button href={`/audio-review?filter=${filter.id}`} variant={data.filter === filter.id ? 'default' : 'outline'}>{filter.label}</Button>
    {/each}
  </nav>
  {#if form && 'error' in form}<p role="alert" class="text-red-400">{form.error}</p>{/if}
  {#if form && 'success' in form}<p role="status" class="text-green-400">Shadow review saved.</p>{/if}
  {#each data.rows as scan (scan.id)}
    <article class="space-y-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
      <div class="flex flex-wrap justify-between gap-2">
        <h2 class="font-semibold text-white">Media {scan.imageId} · {scan.type}</h2>
        <span class="text-dark-2">{scan.createdAt.toLocaleString()} · {scan.status}</span>
      </div>
      {#if scan.type === 'video'}
        <!-- Transcripts below provide the text alternative for this review player. -->
        <!-- svelte-ignore a11y_media_has_caption -->
        <video controls preload="none" class="max-h-80 w-full" src={getEdgeUrl(scan.sourceUrl, { type: 'video', original: true })}></video>
      {:else}
        <audio controls preload="none" class="w-full" src={getEdgeUrl(scan.sourceUrl, { type: 'audio', original: true })}></audio>
      {/if}
      {#if scan.error}<p class="text-red-400">{scan.error} · {scan.attempts} attempts</p>{/if}
      {#if scan.result?.hasAudio === false}
        <p class="text-dark-2">No audio track. No transcript verdict was produced.</p>
      {:else if scan.result?.hasAudio}
        <p class="font-medium">{scan.flagged ? 'Flagged for review' : 'No match found'}</p>
        <details open={scan.flagged === true}>
          <summary class="text-dark-2">Transcript</summary>
          <p class="mt-3 whitespace-pre-wrap break-words">{scan.result.lyrics || '(No speech or lyrics transcribed)'}</p>
        </details>
        {#if scan.reviewedAt}
          <p class="text-dark-2">Reviewed: {scan.wouldBlock ? 'Would block' : 'Would allow'} · moderator {scan.reviewerId ?? 'removed'} · {scan.reviewedAt.toLocaleString()}</p>
          {#if scan.reviewNotes}<p class="whitespace-pre-wrap">{scan.reviewNotes}</p>{/if}
        {:else if data.grants['audio.review']}
          <form method="POST" action="?/review" use:enhance class="space-y-3">
            <input type="hidden" name="id" value={scan.id} />
            <input type="hidden" name="sourceHash" value={scan.sourceHash} />
            <Textarea name="notes" aria-label={`Review notes for media ${scan.imageId}`} placeholder="Review notes (optional)" maxlength={2000} />
            <div class="flex gap-2">
              <Button type="submit" name="wouldBlock" value="yes" variant="destructive">Would block</Button>
              <Button type="submit" name="wouldBlock" value="no" variant="outline">Would allow</Button>
            </div>
          </form>
        {/if}
      {/if}
    </article>
  {:else}
    <p class="text-dark-2">No scans in this view.</p>
  {/each}
  {#if data.nextCursor}
    <Button href={`/audio-review?filter=${data.filter}&cursor=${data.nextCursor}`} variant="outline">Next page</Button>
  {/if}
</div>
