<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import {
    PRESERVED_VERDICT_LABELS,
    PRESERVED_VERDICTS,
    PRESERVED_VIEW_HEADER,
    type PreservedVerdict,
  } from '$lib/preserved-view';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // One open at a time. Fetched rather than set as an <img> src: the route needs a header an <img>
  // cannot send, and a fetch is never answered from the page's image cache, so every open is a request.
  let open = $state<{ n: number; url: Promise<string> } | null>(null);
  // The verdict buttons follow an image the browser rendered, never a click alone.
  let shown = $state<number | null>(null);

  async function fetchFile(n: number): Promise<string> {
    const res = await fetch(`/api/preserved-view/${n}`, {
      headers: { [PRESERVED_VIEW_HEADER]: 'open' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`The file could not be shown (${res.status}).`);
    return URL.createObjectURL(await res.blob());
  }

  function openFile(n: number) {
    shown = null;
    open = { n, url: fetchFile(n) };
  }

  $effect(() => {
    const current = open;
    return () => void current?.url.then(URL.revokeObjectURL, () => null);
  });
  let confirming = $state<{ n: number; verdict: PreservedVerdict } | null>(null);
  let submitting = $state(false);

  const formError = $derived(form && 'error' in form ? { n: form.n, message: String(form.error) } : null);
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  const submitVerdict: SubmitFunction = () => {
    submitting = true;
    return async ({ update }) => {
      try {
        await update();
      } finally {
        submitting = false;
        confirming = null;
      }
    };
  };
</script>

<svelte:head><title>Preserved-file review</title></svelte:head>

<div class="mx-auto flex max-w-4xl flex-col gap-4">
  <div>
    <h1 class="text-xl font-semibold text-white">Preserved-file review</h1>
    <p class="text-sm text-dark-2">
      Each file loads only when you open it, and every open is recorded. Record one verdict per file:
      it is final, and a file with a verdict is no longer shown.
    </p>
  </div>

  {#if formError && !data.files.some((f) => f.n === formError.n)}
    <ErrorAlert message={formError.message} />
  {/if}

  {#each data.files as file (file.n)}
    <section class="flex flex-col gap-3 rounded-xl border border-dark-4 bg-dark-6 p-4">
      <div class="flex items-baseline justify-between gap-2">
        <h2 class="font-semibold text-white">File {file.n}</h2>
        <span class="text-sm text-dark-2">{mb(file.size)}</span>
      </div>

      {#if file.verdict}
        <p class="text-sm text-white">
          Verdict recorded: {PRESERVED_VERDICT_LABELS[file.verdict]}
        </p>
      {:else}
        {#if open?.n === file.n}
          {#await open.url}
            <p class="text-sm text-dark-2">Loading file {file.n}…</p>
          {:then src}
            <img
              {src}
              alt="Preserved file {file.n}"
              class="max-h-[80vh] max-w-full self-center object-contain"
              onload={() => (shown = file.n)}
              onerror={() => (shown = null)}
            />
          {:catch e}
            <ErrorAlert
              message="{e instanceof Error ? e.message : 'The file could not be shown.'} No verdict can be recorded for it; tell the Moderation Lead."
            />
          {/await}
        {:else}
          <div>
            <Button type="button" variant="outline" size="sm" onclick={() => openFile(file.n)}>
              Open file {file.n}
            </Button>
          </div>
        {/if}

        {#if formError?.n === file.n}
          <ErrorAlert message={formError.message} />
        {/if}

        {#if open?.n === file.n && shown === file.n}
          <form
            method="POST"
            action="?/verdict"
            class="flex flex-wrap items-center gap-2"
            use:enhance={submitVerdict}
          >
            <input type="hidden" name="n" value={file.n} />
            {#if confirming?.n === file.n}
              <span class="text-sm text-white">
                Record "{PRESERVED_VERDICT_LABELS[confirming.verdict]}" for file {file.n}? This is
                final.
              </span>
              <Button
                type="submit"
                name="verdict"
                value={confirming.verdict}
                size="sm"
                variant="destructive"
                disabled={submitting}
              >
                Yes, record it
              </Button>
              <Button type="button" size="sm" variant="outline" onclick={() => (confirming = null)}>
                Cancel
              </Button>
            {:else}
              {#each PRESERVED_VERDICTS as verdict (verdict)}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={submitting}
                  onclick={() => (confirming = { n: file.n, verdict })}
                >
                  {PRESERVED_VERDICT_LABELS[verdict]}
                </Button>
              {/each}
            {/if}
          </form>
        {/if}
      {/if}
    </section>
  {:else}
    <p class="text-sm text-dark-2">The pinned manifest names no files.</p>
  {/each}
</div>
