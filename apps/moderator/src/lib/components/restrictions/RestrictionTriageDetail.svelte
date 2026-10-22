<script lang="ts">
  import { deserialize, enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { untrack } from 'svelte';
  import { IconExternalLink, IconPhoto, IconUser } from '@tabler/icons-svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import {
    reasonRequiresNote,
    resolutionReasonLabel,
  } from '@civitai/shared/resolution-reasons';
  import BanConfirmForm from '$lib/components/BanConfirmForm.svelte';
  import ResolutionReasonFields from '$lib/components/ResolutionReasonFields.svelte';
  import type { RulingDraft } from '$lib/components/RulingForm.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import TriageColumns from '$lib/components/triage/TriageColumns.svelte';
  import { denied } from '$lib/permissions';
  import UserWorkflowsPanel from '$lib/components/UserWorkflowsPanel.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_BUTTON, dateTime, shortAge } from '$lib/format';
  import { unwiredRulingReason } from '$lib/restriction-types';
  import { sourceState } from '$lib/restrictions/origin';
  import { countNotBlocking, planRecheck, type Recheck } from '$lib/restrictions/recheck';
  import { groupRepeats, formatSpan } from '$lib/restrictions/trigger-groups';
  import { summarizeTriggers } from '$lib/restrictions/trigger-summary';
  import type { RemixSource, RestrictionRow } from '$lib/server/user-restriction.service';
  import type { Outcome } from '$lib/triage/queue';
  import RestrictionDecisionForm from './RestrictionDecisionForm.svelte';
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

  const triggerCount = $derived(summarizeTriggers(row.triggers));
  const triggerSpan = $derived(
    triggerCount.first && triggerCount.last
      ? Date.parse(triggerCount.last) - Date.parse(triggerCount.first)
      : null
  );
  const generationsId = $derived(`restriction-${row.id}-generations`);

  const hint = $derived(
    draft.verdict === 'Upheld'
      ? 'Upholding keeps the generator mute. The user sees the reason, not the note.'
      : draft.verdict === 'Overturned'
        ? 'Overturning lifts the generator mute. The user sees the reason, not the note.'
        : `Pick a verdict, then confirm it with a reason.${selected.size > 0 ? ' Flagging a false positive feeds the word-list review.' : ''}`
  );

  const VERDICT_BUTTON = 'h-8 gap-2 rounded-md px-3.5 text-[13px] font-semibold';
  const flagFormId = $derived(`restriction-${row.id}-flag`);

  let banOpen = $state(false);
  let banReason = $state('');
  const banEnhancer: SubmitFunction = (input) => {
    banOpen = false;
    return submit('Banned and upheld')(input);
  };
</script>

{#snippet extras()}
  <!-- Shown to everyone on a pending row, disabled with the reason when the viewer lacks the grant: a
       ban that is simply absent read as the page having none. -->
  <Button
    type="button"
    variant="outline"
    class="{VERDICT_BUTTON} border-dark-4 bg-transparent dark:bg-transparent"
    disabled={!canBan || !!unwiredReason}
    title={!canBan ? denied('audit.ban.execute') : (unwiredReason ?? undefined)}
    onclick={() => ((banReason = ''), (banOpen = true))}
  >
    Ban user…
  </Button>
  {#if selected.size > 0}
    <!-- Its form is a sibling of the ruling form: forms do not nest. -->
    <Button
      type="submit"
      form={flagFormId}
      variant="outline"
      class="{VERDICT_BUTTON} border-dark-4 bg-transparent dark:bg-transparent"
      disabled={flag.submitting}
    >
      Flag {selected.size} as false {selected.size === 1 ? 'positive' : 'positives'}
    </Button>
  {/if}
  {#if flag.error}<span class="col-span-2 text-sm text-red-300">{flag.error}</span>{/if}
{/snippet}

{#snippet decision()}
  <RestrictionDecisionForm
    restrictionId={row.id}
    {unwiredReason}
    {hint}
    {submit}
    {actionHref}
    {extras}
    bind:draft
  />
  {#if !canBan}
    <p class="m-0 mt-2 text-[11px] text-amber-300">{denied('audit.ban.execute')}</p>
  {/if}
  {#if selected.size > 0}
    <form
      id={flagFormId}
      method="POST"
      action={actionHref('flagSuspicious')}
      use:enhance={flag.enhance}
      hidden
    >
      <input type="hidden" name="userRestrictionId" value={row.id} />
      {#each [...selected] as key (key)}
        <input type="hidden" name="key" value={key} />
      {/each}
    </form>
  {/if}
{/snippet}

{#snippet header()}
  <div class="space-y-2">
    <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div class="min-w-0 flex-1 basis-80 space-y-1.5">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 class="m-0 text-lg font-semibold break-words text-white">{name}</h2>
          <span class="text-[13px] text-dark-2 tabular-nums">#{row.userId}</span>
          <StatusBadge status={row.status} outline />
        </div>
        <p class="m-0 text-sm text-dark-2">
          Account {shortAge(row.userCreatedAt)} old · restricted
          <span title={dateTime(row.createdAt)}>{shortAge(row.createdAt)} ago</span>
          {#if row.resolvedAt}
            · ruled <span title={dateTime(row.resolvedAt)}>{shortAge(row.resolvedAt)} ago</span>
          {/if}
          · {triggerCount.total}
          {triggerCount.total === 1 ? 'trigger' : 'triggers'}
          {#if triggerCount.total > 1 && triggerCount.distinctPrompts > 0}
            · {triggerCount.distinctPrompts}
            {triggerCount.distinctPrompts === 1 ? 'prompt' : 'prompts'}
            {#if triggerSpan}· over {formatSpan(triggerSpan)}{/if}
          {/if}
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        {#if row.username}
          <Button
            variant="outline"
            size="sm"
            class={LINK_BUTTON}
            href="{civitaiUrl}/user/{row.username}"
            target="_blank"
            rel="noreferrer"
          >
            <IconExternalLink aria-hidden="true" /> Profile
          </Button>
        {/if}
        <Button
          variant="outline"
          size="sm"
          class={LINK_BUTTON}
          href={userLookupUrl(row.username ?? row.userId)}
        >
          <IconUser aria-hidden="true" /> User lookup
        </Button>
        {#if canViewGenerations}
          <!-- The generations are the panel further down the middle column, not a page of their own. -->
          <Button
            variant="outline"
            size="sm"
            class={LINK_BUTTON}
            onclick={() =>
              document.getElementById(generationsId)?.scrollIntoView({ behavior: 'smooth' })}
          >
            <IconPhoto aria-hidden="true" /> Generations
          </Button>
        {/if}
      </div>
    </div>
    {#if unwiredReason && pending}
      <p class="m-0 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
        {unwiredReason}
      </p>
    {/if}
  </div>
{/snippet}

<!-- What tripped the restriction, and the account's generations, in the middle. -->
{#snippet evidence()}
  <div class="space-y-5">
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

    <div id={generationsId}>
      <UserWorkflowsPanel userId={row.userId} canView={canViewGenerations} />
    </div>
  </div>
{/snippet}

<!-- The user's side and the ruling in the sidebar. -->
{#snippet info()}
  {#if row.userMessage}
    <TriageCard dense title="What the user says">
      <p class="m-0 break-words whitespace-pre-wrap text-dark-0">{row.userMessage}</p>
      {#if row.userMessageAt}
        <p class="m-0 mt-2 text-xs text-dark-2">{dateTime(row.userMessageAt)}</p>
      {/if}
    </TriageCard>
  {:else}
    <p class="m-0 text-sm text-dark-2">The user has said nothing about this restriction.</p>
  {/if}

  {#if row.resolvedAt}
    <TriageCard dense title="Resolution">
      <div class="space-y-1 text-dark-0">
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

<TriageColumns {verdict} {error} {header} {evidence} {info} decision={pending ? decision : undefined} />
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
