<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import * as Popover from '@civitai/ui/components/ui/popover/index.js';
  import ConfirmButton from '$lib/components/ConfirmButton.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { denied } from '$lib/permissions';
  import { num } from '$lib/format';
  import type { TurnEvent } from '$lib/assistant/types';
  import TurnView from './TurnView.svelte';
  import { streamTurn } from './turn-stream';
  import { starterPrompt } from './starters';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const canUse = $derived(!!data.grants['assistant.use']);
  const NO_PLAYBOOK = '';

  // The turn in flight: what was asked, and what the stream has said so far. Cleared once the
  // transcript (from `load`) holds the finished turn.
  let pending = $state<{
    prompt: string;
    tools: { name: string; done: boolean; rows: number | null; error: string | null }[];
    error: string | null;
  } | null>(null);

  // A turn running server-side that this page did not start (another tab, or a reload mid-turn).
  const running = $derived(data.turns.some((t) => t.status === 'running'));
  const chatSources = $derived(data.turns.flatMap((t) => t.sources));

  // The page is remounted per chat; a stream still open for the old one is dropped, not reported.
  const leaving = new AbortController();
  onDestroy(() => leaving.abort());
  const busy = $derived((!!pending && !pending.error) || running);

  // The question being written, seeded from what the chat was opened on. The layout remounts this
  // page per chat, so seeding once is enough.
  let prompt = $state(untrack(() => (data.turns.length ? '' : starterPrompt(data.chat))));
  let playbook = $state(NO_PLAYBOOK);
  // Seeded from the chat's last turn; the layout remounts this page per chat.
  let model = $state(untrack(() => data.model));

  async function send() {
    const text = prompt.trim();
    if (!text || busy) return;
    const chatId = data.chat.id;
    pending = { prompt: text, tools: [], error: null };
    const current = pending;
    prompt = '';
    await streamTurn(
      chatId,
      { prompt: text, playbook: playbook || null, model },
      (event: TurnEvent) => {
      if (event.type === 'tool') current.tools.push({ name: event.name, done: false, rows: null, error: null });
      else if (event.type === 'tool-done') {
        const t = current.tools.findLast((x) => x.name === event.name && !x.done);
        if (t) Object.assign(t, { done: true, rows: event.rows, error: event.error });
        else current.tools.push({ name: event.name, done: true, rows: event.rows, error: event.error });
      } else if (event.type === 'error') current.error = event.error;
      },
      leaving.signal
    );
    if (leaving.signal.aborted) return;
    if (current.error) {
      // Give the question back, so a refusal does not cost the moderator what they typed.
      if (!prompt) prompt = text;
      return;
    }
    await invalidateAll();
    if (pending === current) pending = null;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  }

  const rename = new FormState({ onSuccess: null, reload: true, reset: false });
  const archive = new FormState({ onSuccess: null });
  // Follows the stored title (the first question names a new chat) until the moderator edits it.
  let title = $derived(data.chat.title);
  const playbookLabel = $derived(
    data.playbooks.find((p) => p.slug === playbook)?.title ?? 'No playbook'
  );
  const modelLabel = $derived(data.models.find((m) => m.id === model)?.label ?? model);
  const usd = (n: number) => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`);
</script>

<header class="mb-4 flex flex-wrap items-center justify-between gap-2">
  <form
    method="POST"
    action="?/rename"
    use:enhance={rename.enhance}
    class="flex w-full min-w-0 gap-2 sm:w-auto sm:flex-1"
  >
    <Input
      name="title"
      bind:value={title}
      maxlength={120}
      aria-label="Chat title"
      class="max-w-md min-w-0 font-semibold"
      disabled={!canUse}
    />
    {#if canUse && title.trim() !== data.chat.title}
      <Button type="submit" size="sm" variant="outline" disabled={rename.submitting}>Rename</Button>
    {/if}
  </form>
  <div class="flex flex-wrap items-center gap-2 text-xs text-dark-2">
    <span>{usd(data.allowance.spentUsd)} of {usd(data.allowance.capUsd)} today</span>
    {#if data.spend.byModel.length}
      <!-- A popover, not a title: the per-model split must reach a phone and a keyboard too. -->
      <Popover.Root>
        <Popover.Trigger class="underline decoration-dotted underline-offset-2">
          By model
        </Popover.Trigger>
        <Popover.Content align="end" class="w-64 text-xs">
          <p class="mt-0 mb-2 text-dark-2">
            Estimated at OpenRouter's list prices. The router picks the provider per call, so the real
            cost can differ. Your daily allowance counts each answer at the higher of today's price and
            the price this release shipped with.
          </p>
          {#if !data.spend.current}
            <p class="mt-0 mb-2 text-amber-300">
              OpenRouter's current prices could not be read, so some of this uses the prices this
              release shipped with, which may be out of date.
            </p>
          {/if}
          <ul class="m-0 space-y-1 p-0">
            {#each data.spend.byModel as r (r.model)}
              <li class="flex justify-between gap-2">
                <span>{r.label}</span>
                <span class="text-dark-0">{r.usd === null ? 'price unknown' : usd(r.usd)}</span>
              </li>
            {/each}
          </ul>
          {#if data.spend.unpricedTokens}
            <p class="mt-2 mb-0 text-amber-300">
              {num(data.spend.unpricedTokens)} tokens on models with no price are not in the total.
            </p>
          {/if}
        </Popover.Content>
      </Popover.Root>
    {/if}
    {#if canUse}
      <form method="POST" action="?/archive" use:enhance={archive.enhance}>
        <ConfirmButton
          label="Archive"
          title="Archive this chat?"
          description="It leaves your list. Its questions and answers stay in the assistant audit."
        />
      </form>
    {/if}
  </div>
</header>
{#if rename.error}<ErrorAlert message={rename.error} class="mb-3" />{/if}
{#if archive.error}<ErrorAlert message={archive.error} class="mb-3" />{/if}

<div class="space-y-6">
  {#each data.turns as turn (turn.id)}
    <TurnView {turn} sources={chatSources} onRefresh={invalidateAll} />
  {/each}

  {#if pending}
    <article class="space-y-3">
      <div class="ml-auto max-w-[90%] rounded-lg bg-dark-5 px-3 py-2 text-sm break-words whitespace-pre-wrap text-dark-0 sm:max-w-[75%]">
        {pending.prompt}
      </div>
      <div class="rounded-lg border border-dark-4 bg-dark-6 px-4 py-3 text-sm">
        {#if pending.error}
          <p class="text-red-300">{pending.error}</p>
        {:else}
          <p class="text-dark-2">Looking into it…</p>
        {/if}
        {#if pending.tools.length}
          <ul class="mt-2 space-y-0.5 text-xs text-dark-2">
            {#each pending.tools as t, i (i)}
              <li>
                <code class="text-dark-0">{t.name}</code>
                {#if !t.done}…{:else if t.error}— {t.error}{:else}— {num(t.rows ?? 0)} rows{/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </article>
  {/if}
</div>

{#if canUse}
  <form
    class="sticky bottom-0 mt-6 rounded-xl border border-dark-4 bg-dark-6 p-3"
    onsubmit={(e) => {
      e.preventDefault();
      void send();
    }}
  >
    <Textarea
      bind:value={prompt}
      onkeydown={onKeydown}
      rows={3}
      maxlength={4000}
      placeholder="Ask about an account, a list of accounts, a report…"
      aria-label="Question"
      disabled={busy}
    />
    <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
      <!-- One line on a phone: the composer is sticky, so every extra row costs the transcript. -->
      <div class="flex w-full min-w-0 gap-2 sm:w-auto">
        <Select.Root type="single" bind:value={() => playbook, (v) => (playbook = v ?? NO_PLAYBOOK)}>
          <Select.Trigger class="min-w-0 flex-1 text-xs sm:w-64 sm:flex-none" aria-label="Playbook">
            {playbookLabel}
          </Select.Trigger>
          <Select.Content>
            <Select.Item value={NO_PLAYBOOK}>No playbook</Select.Item>
            {#each data.playbooks as p (p.slug)}
              <Select.Item value={p.slug}>{p.title}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
        <Select.Root type="single" bind:value={() => model, (v) => (model = v || data.model)}>
          <Select.Trigger class="min-w-0 flex-1 text-xs sm:w-44 sm:flex-none" aria-label="Model">
            {modelLabel}
          </Select.Trigger>
          <Select.Content>
            {#each data.models as m (m.id)}
              <Select.Item value={m.id}>{m.label}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <div class="flex items-center gap-2">
        <span class="hidden text-xs text-dark-2 sm:inline">Ctrl+Enter</span>
        <Button type="submit" disabled={busy || !prompt.trim()}>
          {busy ? 'Working…' : 'Ask'}
        </Button>
      </div>
    </div>
  </form>
{:else}
  <p class="mt-6 text-sm text-dark-2">{denied('assistant.use')}</p>
{/if}
