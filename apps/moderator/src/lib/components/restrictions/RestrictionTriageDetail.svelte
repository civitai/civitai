<script lang="ts">
  import { deserialize, enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import { Kbd } from '@civitai/ui/components/ui/kbd/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import {
    reasonRequiresNote,
    resolutionReasonError,
    resolutionReasonLabel,
  } from '@civitai/shared/resolution-reasons';
  import BanConfirmForm from '$lib/components/BanConfirmForm.svelte';
  import ResolutionReasonFields from '$lib/components/ResolutionReasonFields.svelte';
  import type { RulingDraft } from '$lib/components/RulingForm.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import TriageDetailFrame from '$lib/components/triage/TriageDetailFrame.svelte';
  import UserWorkflowsPanel from '$lib/components/UserWorkflowsPanel.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime, shortAge } from '$lib/format';
  import { unwiredRulingReason } from '$lib/restriction-types';
  import { sourceState } from '$lib/restrictions/origin';
  import { countNotBlocking, planRecheck, type Recheck } from '$lib/restrictions/recheck';
  import { groupRepeats } from '$lib/restrictions/trigger-groups';
  import { rulingLabel } from '$lib/restrictions/verdict-label';
  import type { RemixSource, RestrictionRow } from '$lib/server/user-restriction.service';
  import type { Outcome } from '$lib/triage/queue';
  import StatusBadge from './StatusBadge.svelte';
  import TriageTriggerCard from './TriageTriggerCard.svelte';
  import TriggerSummary from './TriggerSummary.svelte';

  type Verdict = 'Upheld' | 'Overturned';

  let {
    row,
    civitaiUrl,
    canBan,
    canViewGenerations,
    sources,
    sourcesFailed,
    sourcesNotLoaded,
    verdict,
    error,
    submit,
    actionHref,
    choose,
    draft = $bindable(),
  }: {
    row: RestrictionRow;
    civitaiUrl: string;
    canBan: boolean;
    canViewGenerations: boolean;
    sources: Record<number, RemixSource>;
    sourcesFailed: boolean;
    sourcesNotLoaded: readonly number[];
    /** The outcome already chosen for this restriction, shown in place of the actions. */
    verdict: string | undefined;
    error: string | undefined;
    submit: (outcome: Outcome) => SubmitFunction;
    actionHref: (action: string) => string;
    choose: (verdict: Verdict) => void;
    draft: RulingDraft<Verdict>;
  } = $props();

  const groups = $derived(groupRepeats(row.triggers));
  const pending = $derived(row.status === 'Pending');
  // The server refuses these rows too; this only stops the moderator being invited to click a control
  // whose one possible outcome is a 400.
  const unwiredReason = $derived(unwiredRulingReason(row.type));
  const name = $derived(row.username ?? `#${row.userId}`);

  // Fetched on open, per restriction: `load` does not re-run when the selection changes.
  let rechecks = $state<Record<number, Recheck | 'loading' | 'failed'>>({});
  const recheck = $derived(rechecks[row.id]);
  const notBlocking = $derived(typeof recheck === 'object' ? countNotBlocking(recheck) : 0);
  const needsRecheck = $derived(planRecheck(row.triggers).inputs.length > 0);

  $effect(() => {
    const id = row.id;
    if (!needsRecheck || untrack(() => rechecks[id])) return;
    rechecks[id] = 'loading';
    const body = new FormData();
    body.set('userRestrictionId', String(id));
    fetch(actionHref('recheck'), {
      method: 'POST',
      body,
      headers: { 'x-sveltekit-action': 'true' },
    })
      .then(async (res) => {
        const result = deserialize(await res.text());
        rechecks[id] =
          result.type === 'success' && result.data?.recheck
            ? (result.data.recheck as Recheck)
            : 'failed';
      })
      .catch(() => (rechecks[id] = 'failed'));
  });

  const selected = new SvelteSet<string>();
  // A repeat group is one card: ticking it ticks every attempt in it, and the form still posts each key.
  const toggle = (keys: string[]) => {
    const all = keys.every((k) => selected.has(k));
    for (const k of keys) {
      if (all) selected.delete(k);
      else selected.add(k);
    }
  };

  const flag = new FormState({
    // The server's count: it drops any trigger that no longer exists.
    onSuccess: (data) => {
      const count = data?.savedCount ?? selected.size;
      toast.success(`Flagged ${count} as false ${count === 1 ? 'positive' : 'positives'}`);
      selected.clear();
    },
  });

  const unrecordable = $derived(
    draft.verdict
      ? resolutionReasonError('restriction', draft.verdict, draft.reason, draft.note)
      : null
  );

  let banOpen = $state(false);
  let banReason = $state('');
  const banEnhancer: SubmitFunction = (input) => {
    banOpen = false;
    return submit('Banned and upheld')(input);
  };
</script>

{#snippet bar()}
    <Button
      size="lg"
      class="h-11 px-5 text-base"
      variant={draft.verdict === 'Upheld' ? 'destructive' : 'outline'}
      aria-pressed={draft.verdict === 'Upheld'}
      disabled={!!unwiredReason}
      onclick={() => choose('Upheld')}
    >
      Uphold mute <Kbd>1</Kbd>
    </Button>
    <Button
      size="lg"
      class="h-11 px-5 text-base"
      variant={draft.verdict === 'Overturned' ? 'default' : 'outline'}
      aria-pressed={draft.verdict === 'Overturned'}
      disabled={!!unwiredReason}
      onclick={() => choose('Overturned')}
    >
      Overturn (remove mute) <Kbd>2</Kbd>
    </Button>
    {#if canBan}
      <Button
        size="lg"
        variant="outline"
        class="h-11 text-base"
        disabled={!!unwiredReason}
        onclick={() => ((banReason = ''), (banOpen = true))}
      >
        Ban user…
      </Button>
    {/if}
    {#if selected.size > 0}
      <form method="POST" action={actionHref('flagSuspicious')} use:enhance={flag.enhance}>
        <input type="hidden" name="userRestrictionId" value={row.id} />
        {#each [...selected] as key (key)}
          <input type="hidden" name="key" value={key} />
        {/each}
        <Button type="submit" size="lg" variant="outline" class="h-11 text-base" disabled={flag.submitting}>
          Flag {selected.size} as false {selected.size === 1 ? 'positive' : 'positives'}
        </Button>
      </form>
    {/if}
    {#if flag.error}<span class="text-sm text-red-300">{flag.error}</span>{/if}

    {#if draft.verdict}
      <form
        method="POST"
        action={actionHref('resolve')}
        use:enhance={submit(rulingLabel)}
        class="grid w-full gap-2 rounded-md border border-dark-4 bg-dark-7 p-3"
      >
        <input type="hidden" name="userRestrictionId" value={row.id} />
        <input type="hidden" name="status" value={draft.verdict} />
        <ResolutionReasonFields
          subject="restriction"
          verdict={draft.verdict}
          idPrefix="restriction-{row.id}"
          bind:reason={() => draft.reason, (reason) => (draft = { ...draft, reason })}
          bind:note={() => draft.note, (note) => (draft = { ...draft, note })}
        />
        <div>
          <Button
            type="submit"
            size="lg"
            variant={draft.verdict === 'Upheld' ? 'destructive' : 'default'}
            disabled={!!unrecordable || !!unwiredReason}
          >
            Confirm {draft.verdict === 'Upheld' ? 'uphold' : 'overturn'}
          </Button>
        </div>
      </form>
    {/if}
{/snippet}

<TriageDetailFrame {verdict} {error} actions={pending ? bar : undefined}>
  {#snippet children()}
    <header class="space-y-2">
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <a href={userLookupUrl(row.username ?? row.userId)} class="text-lg font-semibold {LINK_CLASS}">
          {name}
        </a>
        <code class="text-sm text-dark-2">#{row.userId}</code>
        <StatusBadge status={row.status} />
      </div>
      <p class="m-0 text-sm text-dark-2">
        Account {shortAge(row.userCreatedAt)} old · restricted
        <span title={dateTime(row.createdAt)}>{shortAge(row.createdAt)} ago</span>
        {#if row.username}
          · <a href="{civitaiUrl}/user/{row.username}" target="_blank" rel="noreferrer" class={LINK_CLASS}>Profile ↗</a>
        {/if}
        · <a href={userLookupUrl(row.username ?? row.userId)} class={LINK_CLASS}>User lookup</a>
      </p>
      {#if unwiredReason && pending}
        <p
          class="m-0 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
        >
          {unwiredReason}
        </p>
      {/if}
    </header>

    {#if row.triggers.length > 1}
      <TriggerSummary
        triggers={row.triggers}
        recheck={typeof recheck === 'object' ? recheck : undefined}
      />
    {/if}

    {#if notBlocking > 0}
      <div class="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
        {notBlocking} of {row.triggers.length}
        {row.triggers.length === 1 ? 'trigger' : 'triggers'} would not block under the current word
        list. They were likely warnings counted toward the mute.
      </div>
    {/if}

    <div class="space-y-4">
      {#each groups as group (group.triggers[0].key)}
        {@const trigger = group.triggers[0]}
        {@const sourceId = trigger.origin?.remix?.imageId ?? trigger.remixOfId}
        <TriageTriggerCard
          repeats={group.triggers}
          index={group.start}
          {civitaiUrl}
          source={sourceId ? sources[sourceId] : undefined}
          sourceState={sourceId
            ? sourceState(sourceId, { sources, failed: sourcesFailed, notLoaded: sourcesNotLoaded })
            : undefined}
          recheck={typeof recheck === 'object' && recheck.byKey[trigger.key] !== undefined
            ? recheck.results[recheck.byKey[trigger.key]]
            : undefined}
          recheckStatus={recheck === 'loading' || recheck === 'failed' ? recheck : undefined}
          selected={group.triggers.every((r) => selected.has(r.key))}
          onToggle={toggle}
        />
      {/each}
    </div>

    <UserWorkflowsPanel userId={row.userId} canView={canViewGenerations} />

    {#if row.userMessage}
      <TriageCard title="What the user says">
        <p class="m-0 text-base break-words whitespace-pre-wrap text-dark-0">{row.userMessage}</p>
        {#if row.userMessageAt}
          <p class="m-0 mt-3 text-sm text-dark-2">{dateTime(row.userMessageAt)}</p>
        {/if}
      </TriageCard>
    {/if}

    {#if row.resolvedAt}
      <TriageCard title="Resolution">
        <div class="space-y-1 text-sm text-dark-0">
          <p class="m-0 text-xs text-dark-2">Resolved {dateTime(row.resolvedAt)}</p>
          {#if row.resolvedReason}
            <p class="m-0">Reason: {resolutionReasonLabel(row.resolvedReason)}</p>
          {/if}
          {#if row.internalNotes}<p class="m-0 text-dark-2">Note: {row.internalNotes}</p>{/if}
          {#if row.resolvedMessage}<p class="m-0">{row.resolvedMessage}</p>{/if}
        </div>
      </TriageCard>
    {/if}
  {/snippet}
</TriageDetailFrame>

{#if pending}
    <Dialog.Root bind:open={banOpen}>
      <Dialog.Content class="sm:max-w-xl">
        <Dialog.Header>
          <Dialog.Title>Ban {name}</Dialog.Title>
          <Dialog.Description>This also upholds the restriction.</Dialog.Description>
        </Dialog.Header>
        <BanConfirmForm
          userId={row.userId}
          username={row.username}
          action={actionHref('ban')}
          enhancer={banEnhancer}
          canConfirm={!!banReason}
          noteRequired={reasonRequiresNote(banReason)}
          onCancel={() => (banOpen = false)}
        >
          {#snippet hidden()}
            <input type="hidden" name="userRestrictionId" value={row.id} />
          {/snippet}
          {#snippet prompt()}
            <div class="mb-2">
              <!-- No note box of its own: the ban's internal note is recorded on the ruling too. -->
              <ResolutionReasonFields
                subject="restriction"
                verdict="Upheld"
                idPrefix="restriction-ban-{row.id}"
                showNote={false}
                bind:reason={banReason}
              />
              {#if reasonRequiresNote(banReason)}
                <p class="mt-1 text-xs text-amber-300">
                  Other needs an internal note below saying why; it is recorded on the ruling too.
                </p>
              {/if}
            </div>
          {/snippet}
        </BanConfirmForm>
      </Dialog.Content>
    </Dialog.Root>
{/if}
