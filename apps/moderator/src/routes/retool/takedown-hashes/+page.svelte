<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { num } from '$lib/format';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<header class="page-header">
  <h1>Takedown hashes</h1>
  <p>
    SHA256 hashes of files from models that were unpublished for a violation or deleted, so the same
    file is recognisable if it is uploaded again.
  </p>
</header>

{#if form?.error}
  <div
    class="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
    role="alert"
  >
    {form.error}
  </div>
{:else if form?.success && 'added' in form}
  <div
    class="mb-4 rounded-md border border-green-500/30 bg-green-500/10 p-2 text-sm text-green-200"
    role="status"
  >
    Recorded {num(form.added)} new hashes of {num(form.found)} candidates.
  </div>
{/if}

<!-- A GET form: the hash is in the URL so a lookup can be handed to someone else, matching every other
     filter in this app. -->
<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-1 text-sm font-semibold text-white">Has this file been taken down before?</h2>
  <p class="mb-3 text-xs text-dark-2">Paste a SHA256. Anything else is rejected without a query.</p>
  <form method="GET" class="flex flex-wrap gap-2">
    <Input name="q" value={data.q} placeholder="64 hex characters" class="min-w-80 flex-1 font-mono" />
    <Button type="submit" variant="outline">Look up</Button>
  </form>

  {#if data.q}
    {#if data.matches.length === 0}
      <p class="mt-3 text-sm text-dark-2">
        No match. Either the file has not been taken down, or the hash is not 64 hex characters.
      </p>
    {:else}
      <ul class="mt-3 space-y-1 text-sm">
        {#each data.matches as m (m.sha256 + m.modelVersionId)}
          <li class="flex flex-wrap items-baseline gap-x-3">
            <span class="text-red-300">Previously taken down</span>
            <span class="text-xs text-dark-2">
              model version {m.modelVersionId ?? 'unknown'}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-1 text-sm font-semibold text-white">Record new hashes</h2>
  <p class="mb-3 text-xs text-dark-2">
    {num(data.candidateCount)} files currently belong to taken-down models. Only hashes not already in
    the ledger are written — Retool re-inserted the whole set on every press.
  </p>
  {#if data.canAct}
    <form method="POST" action="?/record" use:enhance>
      <Button type="submit" variant="outline" size="sm">Record</Button>
    </form>
  {:else}
    <p class="text-sm text-dark-2">You do not have permission to write to the ledger.</p>
  {/if}
</section>
