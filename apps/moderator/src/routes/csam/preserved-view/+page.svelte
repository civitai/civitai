<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import {
    PRESERVED_VERDICT_LABELS,
    PRESERVED_VERDICTS,
    type PreservedVerdict,
  } from '$lib/preserved-view';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let open = $state<number | null>(null);
  let confirming = $state<{ n: number; verdict: PreservedVerdict } | null>(null);
  let submitting = $state(false);

  const formError = $derived(form && 'error' in form ? String(form.error) : null);
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  const submitVerdict: SubmitFunction = () => {
    submitting = true;
    return async ({ update }) => {
      await update();
      submitting = false;
      confirming = null;
    };
  };
</script>

<svelte:head><title>Preserved-file review</title></svelte:head>

<div class="mx-auto flex max-w-4xl flex-col gap-4">
  <div>
    <h1 class="text-xl font-semibold">Preserved-file review</h1>
    <p class="text-sm text-dark-2">
      Each file loads only when you open it, and every open is recorded. Record one verdict per file:
      it is final, and a file with a verdict is no longer shown.
    </p>
  </div>

  {#if formError}
    <ErrorAlert message={formError} />
  {/if}

  {#each data.files as file (file.n)}
    <section class="flex flex-col gap-3 rounded-md border border-dark-4 bg-dark-6 p-4">
      <div class="flex items-baseline justify-between gap-2">
        <h2 class="font-semibold">File {file.n}</h2>
        <span class="text-sm text-dark-2">{mb(file.size)}</span>
      </div>

      {#if file.verdict}
        <p class="text-sm">Verdict recorded: {PRESERVED_VERDICT_LABELS[file.verdict]}</p>
      {:else}
        {#if open === file.n}
          <img
            src="/api/preserved-view/{file.n}"
            alt="Preserved file {file.n}"
            class="max-h-[80vh] max-w-full self-center object-contain"
          />
        {:else}
          <div>
            <Button type="button" variant="outline" size="sm" onclick={() => (open = file.n)}>
              Open file {file.n}
            </Button>
          </div>
        {/if}

        {#if file.viewed || open === file.n}
          <form
            method="POST"
            action="?/verdict"
            class="flex flex-wrap items-center gap-2"
            use:enhance={submitVerdict}
          >
            <input type="hidden" name="n" value={file.n} />
            {#if confirming?.n === file.n}
              <span class="text-sm">
                Record "{PRESERVED_VERDICT_LABELS[confirming.verdict]}" for file {file.n}? This is final.
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
  {/each}
</div>
