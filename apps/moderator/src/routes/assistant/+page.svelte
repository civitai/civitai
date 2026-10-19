<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { denied } from '$lib/permissions';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS } from '$lib/format';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const canUse = $derived(!!data.grants['assistant.use']);
  const start = new FormState({ onSuccess: null });
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="m-0 mb-2 text-base font-semibold text-white">Start an investigation</h2>
  <p class="mb-4 text-sm text-dark-2">
    Ask about an account, a report or a hunch. The assistant looks things up — linked accounts by login
    and reaction address, who reacts to whom, Buzz flows, prior reports, old banned accounts — and cites
    every record so you can check it. It cannot act on anything; you decide.
  </p>
  {#if canUse}
    <form method="POST" action="?/start" use:enhance={start.enhance}>
      <Button type="submit" disabled={start.submitting}>New chat</Button>
    </form>
    {#if start.error}<ErrorAlert message={start.error} class="mt-3" />{/if}
    <p class="mt-3 text-xs text-dark-2">
      Or use <strong>Investigate</strong> on a user report or in User Lookup to open a chat about that
      account.
    </p>
  {:else}
    <p class="text-sm text-dark-2">{denied('assistant.use')}</p>
  {/if}
</section>

{#if data.playbookError}
  <ErrorAlert message={data.playbookError} class="mt-6" />
{:else if data.playbooks.length}
  <section class="mt-6">
    <h3 class="mb-2 text-sm font-semibold text-white">Playbooks</h3>
    <ul class="space-y-2 text-sm">
      {#each data.playbooks as p (p.slug)}
        <li>
          <a href="/assistant/playbooks/{p.slug}" class={LINK_CLASS}>{p.title}</a>
          <span class="text-dark-2">— {p.summary}</span>
        </li>
      {/each}
    </ul>
  </section>
{/if}
