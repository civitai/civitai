<script lang="ts">
  import { untrack } from 'svelte';
  import { dateTime } from '$lib/format';
  import { enhance } from '$app/forms';
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { IconCheck, IconExternalLink } from '@tabler/icons-svelte';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import {
    MODEL_UNPUBLISH_REASONS,
    MINOR_UNPUBLISH_REASONS,
    type ModelUnpublishReason,
    modelUnpublishReasonLabel,
    isModelUnpublishReason,
  } from '$lib/model-unpublish-reasons';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { getReportItemUrl, reportStatuses } from '$lib/reports';
  import { denied } from '$lib/permissions';
  import { hasOpenReport, reportsForItem, advanceAfterRuling, itemHref, QUEUE_NAV } from '$lib/report-queue';
  import ReportDetailColumns from '$lib/components/report-queue/ReportDetailColumns.svelte';
  import ReportList from '$lib/components/report-queue/ReportList.svelte';
  import type { ActionResult } from '@sveltejs/kit';
  import { FormState } from '$lib/form-state.svelte';
  import OwnerFlaggedMinorBadge from '$lib/components/minor-flags/OwnerFlaggedMinorBadge.svelte';
  import ModelPreview from '$lib/components/ModelPreview.svelte';
  import type { LayoutData } from './$types';
  import type { ModelItem } from './item.server';

  // The open model, rendered the same by the bare queue (its first model) and by `[modelId]`: the
  // model, every open report about it, and what to do about both. No `form`: every write here goes
  // through a per-form `FormState`, which carries its own result.
  let { data }: { data: LayoutData & { item: ModelItem | null } } = $props();

  const item = $derived(data.item);
  const reports = $derived(item ? reportsForItem(item.reports, data.items, item.modelId) : []);
  // `moderateModel` reads the model from a REPORT, never the form, so a stale tab cannot act on a model
  // other than the one on screen. Any of the model's reports names it.
  const actingReportId = $derived(reports[0]?.id ?? null);
  const mergeChecks = $derived({ ...data.mergePermission, ...item?.mergePermission });
  const name = $derived(
    item?.model?.name ?? data.models.find((m) => m.id === item?.modelId)?.name ?? null
  );

  /**
   * A `gone` refusal means the report was deleted underneath the moderator, so the page reloads and
   * the row leaves. A toast is the only surface that outlives that, so the panel's own copy of the
   * refusal is cleared rather than left showing against a report it was not about.
   * Every other refusal leaves the panel as it is to fix and retry, which is `FormState`'s default.
   */
  const reloadIfGone = (result: ActionResult) => {
    if (result.type !== 'failure' || !result.data?.gone) return;
    toast.error(String(result.data.error ?? 'That report no longer exists.'));
    clearPanelState();
    invalidateAll();
  };

  // A ruling moves the list on to the next report (`ReportList`) and, once the model has none left to
  // rule, the queue on to the next model — so the toast is what says the write landed. Captured at
  // submit because the reload replaces the list before `onSuccess` runs.
  let statusChange: { id: number; status: string } | null = null;
  let pendingId = $state<number | null>(null);
  const moveOn = advanceAfterRuling({
    items: () => data.items,
    currentId: () => item?.modelId,
    hasOpen: () => hasOpenReport(reports),
    open: (id) => goto(itemHref(`/reports/model/${id}`, page.url.search), QUEUE_NAV),
  });
  const statusForm = new FormState({
    onSubmit: ({ formData }) => {
      statusChange = { id: Number(formData.get('id')), status: String(formData.get('status')) };
      pendingId = statusChange.id;
      moveOn.capture();
    },
    onSuccess: () => {
      if (statusChange) toast.success(`Report #${statusChange.id} set to ${statusChange.status}`);
      moveOn.advance();
    },
    reload: true,
    onSettled: (result) => {
      pendingId = null;
      reloadIfGone(result);
    },
  });
  // A model action leaves its reports on screen (ruling on them is their own buttons), so the panel
  // shows the result in place. Its own state is cleared on success all the same: an unpublish reason
  // or an armed confirm belongs to the click that used it.
  const moderateForm = new FormState({
    onSuccess: (result) => {
      unpublishReason = '';
      confirmingModel = null;
      toast.success(String(result?.moderated ?? 'Done'));
    },
    reload: true,
    onSettled: reloadIfGone,
  });
  let unpublishReason = $state<ModelUnpublishReason | ''>('');
  // `<action>:<model id>`, so an armed confirm cannot survive moving to another model.
  let confirmingModel = $state<string | null>(null);

  type ModelState = NonNullable<ModelItem['model']>;
  type Tone = 'live' | 'down' | 'neutral';
  const STATUS_TONE: Record<Tone, string> = {
    live: 'border-green-500/30 bg-green-500/10',
    down: 'border-red-500/30 bg-red-500/10',
    neutral: 'border-amber-500/30 bg-amber-500/10',
  };
  const reasonLabel = (key: string | null) => (key ? modelUnpublishReasonLabel(key) : key);
  const onDate = (iso: string | null) => (iso ? ` on ${fmtDate(iso)}` : '');

  /**
   * The model's state as a sentence. The enum alone misleads at exactly the moment it matters:
   * `Unpublished` is the OWNER's unpublish (a moderator's is `UnpublishedViolation`), and a taken-down
   * model can still read `Published` — `mode` sits on top of `status` rather than replacing it.
   * Checked in precedence order: deleted, then taken down, then the status itself.
   */
  function modelStatusView(m: ModelState): { tone: Tone; label: string; detail: string | null } {
    if (m.deleted) return { tone: 'down', label: 'Deleted', detail: null };
    if (m.mode === 'TakenDown')
      return { tone: 'down', label: `Taken down${onDate(m.takenDownAt)}`, detail: 'Hidden from the site.' };
    switch (m.status) {
      case 'Published':
        return {
          tone: 'live',
          label: 'Published — live on the site',
          detail: m.mode === 'Archived' ? 'Archived by its owner: visible, but no longer updated.' : null,
        };
      case 'UnpublishedViolation':
        return {
          tone: 'down',
          label: `Unpublished as a violation${onDate(m.unpublishedAt)}`,
          detail: m.unpublishedReason ? `Reason: ${reasonLabel(m.unpublishedReason)}` : null,
        };
      case 'Unpublished':
        return {
          tone: 'neutral',
          label: `Unpublished${onDate(m.unpublishedAt)}`,
          detail: 'Not live. Unpublished by its owner, not as a violation.',
        };
      default:
        return { tone: 'neutral', label: m.status, detail: 'Not live on the site.' };
    }
  }

  const fmtDate = dateTime;

  const MERGE_VERDICT_LABEL = {
    allowed: 'Merges were allowed',
    'not-allowed': 'Merges were not allowed',
    unknown: 'Not recorded',
  } as const;
  const MERGE_VERDICT_TONE = {
    allowed: STATUS_TONE.live,
    'not-allowed': STATUS_TONE.down,
    unknown: STATUS_TONE.neutral,
  } as const;

  // A refusal belongs to the model it was raised on; showing another must not inherit it.
  function clearPanelState() {
    statusForm.error = null;
    moderateForm.error = null;
    unpublishReason = '';
    confirmingModel = null;
  }
  let shownId: number | null = null;
  $effect.pre(() => {
    const id = item?.modelId ?? null;
    if (id === shownId) return;
    shownId = id;
    untrack(clearPanelState);
  });
</script>

{#snippet row(title: string, description: string, doneLabel: string | null)}
  <div class="flex items-center justify-between gap-3 p-3">
    <div>
      <p class="m-0 text-sm font-medium text-muted-foreground">{title}</p>
      <p class="m-0 text-xs text-muted-foreground">{description}</p>
    </div>
    {#if doneLabel}{@render done(doneLabel)}{/if}
  </div>
{/snippet}

{#snippet submit(action: string, label: string)}
  <Button
    type="submit"
    name="modelAction"
    value={action}
    size="sm"
    variant="outline"
    disabled={moderateForm.submitting}
  >
    {label}
  </Button>
{/snippet}

<!-- Armed per action AND model, so a confirm left open cannot survive moving to another model. -->
{#snippet confirmable(action: string, label: string, confirmLabel: string, destructive = false)}
  {@const key = `${action}:${item?.modelId}`}
  {#if confirmingModel === key}
    <Button
      type="submit"
      name="modelAction"
      value={action}
      size="sm"
      variant={destructive ? 'destructive' : 'default'}
      disabled={moderateForm.submitting}
    >
      {confirmLabel}
    </Button>
    <Button type="button" size="sm" variant="ghost" onclick={() => (confirmingModel = null)}>
      Cancel
    </Button>
  {:else}
    <Button type="button" size="sm" variant="outline" onclick={() => (confirmingModel = key)}>
      {label}
    </Button>
  {/if}
{/snippet}

{#snippet done(label: string)}
  <span class="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-green-300">
    <IconCheck size={14} />
    {label}
  </span>
{/snippet}

{#if item}
  {@const itemUrl = getReportItemUrl(data.civitaiUrl, data.type, item.modelId, null)}
  <ReportDetailColumns>
    {#snippet header()}
      <header class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 class="m-0 text-lg font-semibold">{name ?? `Model #${item.modelId}`}</h2>
        {#if itemUrl}
          <a href={itemUrl} target="_blank" rel="noreferrer" class="link inline-flex items-center gap-1 text-sm">
            View model #{item.modelId}
            <IconExternalLink size={14} />
          </a>
        {/if}
        {#if item.ownerFlaggedMinor}<OwnerFlaggedMinorBadge />{/if}
      </header>
    {/snippet}

    {#snippet evidence()}
      {#key item.modelId}
        <ModelPreview
          modelId={item.modelId}
          reportId={actingReportId}
          civitaiUrl={data.civitaiUrl}
          canViewTrainingData={data.canViewTrainingData}
        />
      {/key}
    {/snippet}

    {#snippet actions()}
      <!-- 1. The reports: what was said, by whom, and the ruling on each. A report's internal notes go
           with the report they are about (`ReportList` renders them). -->
      <ReportList
        {reports}
        canRule
        action="?/setStatus"
        onSubmit={statusForm.enhance}
        busyId={pendingId}
        error={statusForm.error}
        statuses={reportStatuses}
      >
        {#snippet details(r)}
          {@const check = mergeChecks[r.id]}
          {#if check}
            <!-- A creator can allow merges, let people merge, then forbid it and report the merges. Each
                 version is judged by the source's permission when that version was published. -->
            <section class="flex flex-col gap-2">
              <span class="text-xs font-medium text-muted-foreground">Merge permission when made</span>
              {#if !check.source}
                <p class="m-0 rounded-md border border-dashed p-2 text-sm text-muted-foreground">
                  The source model #{check.sourceModelId} no longer exists, so there is nothing to check
                  against.
                </p>
              {:else}
                <p class="m-0 text-sm">
                  Source:
                  <a
                    class="link"
                    href={`${data.civitaiUrl}/models/${check.source.id}`}
                    target="_blank"
                    rel="noreferrer">{check.source.name}</a
                  >
                  — merges {check.source.allowDerivatives ? 'allowed' : 'not allowed'} today.
                </p>
                {#if check.versions.length}
                  <ul class="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                    {#each check.versions as version (version.id)}
                      <li class="rounded-md border p-2 {MERGE_VERDICT_TONE[version.verdict.status]}">
                        <span class="font-medium">{MERGE_VERDICT_LABEL[version.verdict.status]}</span>
                        <span class="text-muted-foreground">— {version.name}, {fmtDate(version.madeAt)}</span>
                        {#if version.verdict.status === 'unknown'}
                          <p class="m-0 mt-0.5 text-xs text-muted-foreground">
                            {version.verdict.reason === 'before-source-existed'
                              ? 'Made before the source model existed.'
                              : `Permissions are recorded from ${fmtDate(version.verdict.knownSince)}.`}
                          </p>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <p class="m-0 text-sm text-muted-foreground">The reported model has no versions.</p>
                {/if}
                <details class="text-xs">
                  <summary class="cursor-pointer text-muted-foreground">Source permission history</summary>
                  {#if check.timeline.length}
                    <ul class="m-0 mt-2 flex list-none flex-col gap-0.5 p-0">
                      {#each check.timeline as entry, i (i)}
                        <li>
                          {fmtDate(entry.effectiveAt)}: merges {entry.allowDerivatives ? 'allowed' : 'not allowed'}
                        </li>
                      {/each}
                    </ul>
                  {:else}
                    <p class="m-0 mt-2">No recorded change: today's permission has held since records begin.</p>
                  {/if}
                </details>
              {/if}
            </section>
          {/if}
        {/snippet}
        {#snippet empty()}
          <p class="m-0 text-sm text-muted-foreground">No open reports on this model.</p>
        {/snippet}
      </ReportList>

      {@const model = item.model}
      {@const state = model ? modelStatusView(model) : null}
      <!-- 2. Where the model stands NOW. From the page load, which every action reloads, so this
           is never the state from before the click. Said in words, not a raw enum: "Unpublished"
           alone does not say whether the owner or a moderator did it, or why. -->
      <section aria-labelledby="model-status-heading" class="flex flex-col gap-2">
        <h3 id="model-status-heading" class="m-0 text-sm font-semibold">Model status</h3>
        {#if !model || !state}
          <p class="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            This model no longer exists. Rule on its reports above.
          </p>
        {:else}
          <div class="rounded-md border p-3 {STATUS_TONE[state.tone]}">
            <p class="m-0 text-sm font-medium">{state.label}</p>
            {#if state.detail}<p class="m-0 mt-0.5 text-xs text-muted-foreground">{state.detail}</p>{/if}
          </div>
          <div class="flex flex-wrap items-center gap-1 text-xs">
            {#if model.minor}<Badge variant="outline">Minor</Badge>{/if}
            {#if model.sfwOnly}<Badge variant="outline">SFW-only</Badge>{/if}
            {#if model.poi}<Badge variant="outline">Real person (POI)</Badge>{/if}
            {#if model.nsfw}<Badge variant="outline">NSFW</Badge>{/if}
            {#if !model.minor && !model.sfwOnly && !model.poi && !model.nsfw}
              <span class="text-muted-foreground">No content flags.</span>
            {/if}
          </div>
        {/if}
      </section>

      <!-- 3. What to do about the model: the model page's moderator menu, cut down to what answers a
           report. These change the MODEL only — ruling on a report is its own buttons above, a
           separate decision, so the result of an action stays on screen and a second one
           can follow it. Every row stays put once done: it shows a tick and, except for unpublish,
           the undo the model page offers. There is deliberately no delete: a report is answered by
           taking a model down, not by destroying what it was about. -->
      {#if model && state && !model.deleted && actingReportId != null}
        {@const canTakeDown = !!data.grants['model.takeDown']}
        {@const takenDown = model.mode === 'TakenDown'}
        <section aria-labelledby="model-actions-heading" class="flex flex-col gap-3">
          <div>
            <h3 id="model-actions-heading" class="m-0 text-sm font-semibold">Act on the model</h3>
            <p class="m-0 text-xs text-muted-foreground">
              These change the model only. Rule on each report above.
            </p>
          </div>

          {#if model.status === 'Published'}
            <form
              method="POST"
              action="?/moderateModel"
              use:enhance={moderateForm.enhance}
              class="flex flex-col gap-2 rounded-md border p-3"
            >
              <input type="hidden" name="id" value={actingReportId} />
              <input type="hidden" name="modelAction" value="unpublish" />
              <div>
                <p class="m-0 text-sm font-medium">Unpublish as a violation</p>
                <p class="m-0 text-xs text-muted-foreground">
                  Takes the model off the site and tells the owner why, using the reason below.
                </p>
              </div>
              <!-- A hidden input rather than `Select.Root name=`: an unset reason must post nothing,
                   and the primitive would post an empty string. -->
              {#if unpublishReason}<input type="hidden" name="reason" value={unpublishReason} />{/if}
              <Select.Root
                type="single"
                bind:value={() => unpublishReason,
                (v) => (unpublishReason = isModelUnpublishReason(v ?? '') ? (v as ModelUnpublishReason) : '')}
              >
                <Select.Trigger aria-label="Unpublish reason" class="w-full">
                  {unpublishReason ? modelUnpublishReasonLabel(unpublishReason) : 'Pick a reason…'}
                </Select.Trigger>
                <Select.Content>
                  {#each MODEL_UNPUBLISH_REASONS as r (r.value)}
                    <Select.Item value={r.value}>{r.label}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
              {#if unpublishReason}
                <Textarea
                  name="customMessage"
                  rows={2}
                  aria-label="Message to the owner"
                  placeholder={unpublishReason === 'other'
                    ? 'Message to the owner (required)'
                    : 'Extra message to the owner (optional)'}
                />
              {/if}
              {#if unpublishReason && MINOR_UNPUBLISH_REASONS.has(unpublishReason) && !model.minor}
                <!-- Defaults on, as the main app's unpublish dialog does: the reason says the model
                     depicts a minor, and the flag is the half that gets forgotten. -->
                <label class="flex items-center gap-2 text-sm">
                  <Checkbox name="alsoFlagMinor" checked />
                  Also flag the model as depicting a minor
                </label>
              {/if}
              <Button
                type="submit"
                size="sm"
                variant="destructive"
                class="self-start"
                disabled={!unpublishReason || moderateForm.submitting}
              >
                Unpublish
              </Button>
            </form>
          {/if}

          <form
            method="POST"
            action="?/moderateModel"
            use:enhance={moderateForm.enhance}
            class="flex flex-col divide-y rounded-md border"
          >
            <input type="hidden" name="id" value={actingReportId} />

            {#if model.status !== 'Published'}
              <!-- No undo here on purpose: republishing a violation is an appeal decision, and it
                   republishes every version at once. The model page keeps that. -->
              {#if model.status === 'UnpublishedViolation'}
                {@render row(
                  'Unpublish as a violation',
                  'Unpublished. Republishing is done from the model page.',
                  'Unpublished'
                )}
              {:else}
                {@render row(
                  'Unpublish as a violation',
                  'Not published, so there is nothing to unpublish.',
                  null
                )}
              {/if}
            {/if}

            <div class="flex items-center justify-between gap-3 p-3">
              <div>
                <p class="m-0 text-sm font-medium">Flag as depicting a minor</p>
                <p class="m-0 text-xs text-muted-foreground">
                  {model.minor
                    ? 'Flagged as depicting a minor. Unflagging restores the state from before the flag.'
                    : 'Marks the model and its images as minor, which also makes it SFW-only.'}
                </p>
              </div>
              {#if !model.minor}
                {@render submit('setMinor', 'Flag minor')}
              {:else}
                <div class="flex shrink-0 items-center gap-2">
                  {@render done('Flagged')}
                  {@render confirmable('unsetMinor', 'Unflag', 'Yes, unflag')}
                </div>
              {/if}
            </div>

            <div class="flex items-center justify-between gap-3 p-3">
              <div>
                <p class="m-0 text-sm font-medium">Flag as a real person (POI)</p>
                <p class="m-0 text-xs text-muted-foreground">
                  {model.poi
                    ? 'Flagged as depicting a real person. Unflagging leaves it SFW-only.'
                    : 'Marks the model and its images as depicting a real person, which also makes it SFW-only.'}
                </p>
              </div>
              {#if !model.poi}
                {@render submit('setPoi', 'Flag POI')}
              {:else}
                <div class="flex shrink-0 items-center gap-2">
                  {@render done('Flagged')}
                  {@render confirmable('unsetPoi', 'Unflag', 'Yes, unflag')}
                </div>
              {/if}
            </div>

            <div class="flex items-center justify-between gap-3 p-3">
              <div>
                <p class="m-0 text-sm font-medium">Make SFW-only</p>
                <p class="m-0 text-xs text-muted-foreground">
                  {model.minor
                    ? 'SFW-only, because a minor model always is. Unflag minor first to change it.'
                    : model.poi
                      ? 'SFW-only, because a real-person model always is. Unflag POI first to change it.'
                      : model.sfwOnly
                      ? 'SFW-only. Allowing NSFW leaves its current rating as it is.'
                      : 'Rates the model SFW and limits its gallery to SFW images. The owner cannot undo it.'}
                </p>
              </div>
              {#if model.minor || model.poi}
                {@render done('SFW-only')}
              {:else if model.sfwOnly}
                <div class="flex shrink-0 items-center gap-2">
                  {@render done('SFW-only')}
                  {@render submit('unsetSfwOnly', 'Allow NSFW')}
                </div>
              {:else}
                {@render submit('setSfwOnly', 'Make SFW')}
              {/if}
            </div>

            <div class="flex items-center justify-between gap-3 p-3">
              <div>
                <p class="m-0 text-sm font-medium">Take down</p>
                <p class="m-0 text-xs text-muted-foreground">
                  {takenDown
                    ? 'Taken down: hidden from the site until a moderator brings it back.'
                    : 'For ownership and claim reports. Hides the model as taken down; only a moderator can bring it back.'}
                </p>
                {#if !canTakeDown}
                  <!-- Says why the button is greyed out and which permission to ask for on `/admin`. -->
                  <p class="m-0 mt-1 text-xs text-amber-300">{denied('model.takeDown')}</p>
                {/if}
              </div>
              <div class="flex shrink-0 items-center gap-2">
                {#if takenDown}{@render done('Taken down')}{/if}
                {#if !canTakeDown}
                  <Button type="button" size="sm" variant="outline" disabled>
                    {takenDown ? 'Bring back' : 'Take down'}
                  </Button>
                {:else if takenDown}
                  {@render confirmable('bringBack', 'Bring back', 'Yes, bring back')}
                {:else}
                  {@render confirmable('takeDown', 'Take down', 'Yes, take down', true)}
                {/if}
              </div>
            </div>
          </form>

          {#if moderateForm.error}
            <p class="text-sm text-red-300" role="alert">{moderateForm.error}</p>
          {/if}
        </section>
      {/if}
    {/snippet}
  </ReportDetailColumns>
{:else}
  <!-- Only when the view itself is empty: the bare queue opens its first model whenever there is one. -->
  <p class="py-8 text-center text-sm text-dark-2">No reports in this view.</p>
{/if}
