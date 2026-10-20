<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit';
  import { resolutionReasonLabel, type ResolutionVerdict } from '@civitai/shared/resolution-reasons';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import RulingForm, { type RulingDraft } from '$lib/components/RulingForm.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import TriageDetailFrame from '$lib/components/triage/TriageDetailFrame.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime, shortAge } from '$lib/format';
  import type { RulingChoice } from '$lib/ruling-choices';
  import type { SiteAppealRow } from '$lib/server/site-appeals.service';
  import type { Outcome } from '$lib/triage/queue';
  import { approvalEffect, rowTitle } from './site-appeal-display';
  import SiteAppealSubject from './SiteAppealSubject.svelte';

  type Verdict = ResolutionVerdict<'appeal'>;

  let {
    row,
    civitaiUrl,
    canBan,
    choices,
    verdict,
    error,
    submit,
    draft = $bindable(),
  }: {
    row: SiteAppealRow;
    civitaiUrl: string;
    canBan: boolean;
    choices: readonly RulingChoice<Verdict>[];
    /** The outcome already chosen for this appeal, shown in place of the actions. */
    verdict: string | undefined;
    error: string | undefined;
    submit: (outcome: Outcome) => SubmitFunction;
    draft: RulingDraft<Verdict>;
  } = $props();

  // Shown verbatim to the appellant, so each verdict keeps its own: a rejection's wording must not
  // carry over when the moderator switches to approve.
  const messages = $state<Partial<Record<Verdict, string>>>({});
  const effect = $derived(approvalEffect(row.subject, canBan));
  const name = $derived(row.username ?? `#${row.userId}`);
  const ago = (value: Date | string) => `${shortAge(value)} ago`;
</script>

<TriageDetailFrame {verdict} {error}>
  {#snippet children()}
    <header class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 class="m-0 text-lg font-semibold text-white">{rowTitle(row)}</h2>
      <code class="text-sm text-dark-2">appeal #{row.id}</code>
      {#if row.priors.length}
        <Badge variant="secondary" class="h-6 px-2.5 text-sm">
          Repeat: {row.priors.length} earlier
        </Badge>
      {/if}
    </header>

    <div class={['grid gap-4', row.subject.kind !== 'other' && 'lg:grid-cols-2']}>
      <TriageCard title="What they say">
        {#if row.context?.subject}
          <p class="m-0 mb-2 font-medium text-white">{row.context.subject}</p>
        {/if}
        <p class="m-0 text-base break-words whitespace-pre-wrap text-dark-0">{row.appealMessage}</p>
        {#if row.context?.link}
          <p class="m-0 mt-2 text-sm break-all">
            <!-- Appellant-written: anything but http(s) is shown, never followed. -->
            {#if /^https?:\/\//i.test(row.context.link)}
              <a href={row.context.link} target="_blank" rel="noreferrer nofollow" class={LINK_CLASS}>
                {row.context.link} ↗
              </a>
            {:else}
              {row.context.link}
            {/if}
          </p>
        {/if}
        <p class="m-0 mt-3 text-sm text-dark-2" title={dateTime(row.createdAt)}>
          Filed {ago(row.createdAt)} by
          <a href={userLookupUrl(row.userId)} class={LINK_CLASS}>{name}</a>
        </p>
      </TriageCard>

      <SiteAppealSubject {row} {civitaiUrl} />
    </div>

    {#if row.priors.length}
      <TriageCard title="Earlier appeals about this">
        <ul class="m-0 list-none space-y-3 p-0">
          {#each row.priors as prior (prior.id)}
            <li class="rounded-md bg-dark-6 p-3 text-sm text-dark-0">
              <p class="m-0">
                <span class="font-medium text-white">{prior.status}</span>
                {#if prior.resolvedReason}· {resolutionReasonLabel(prior.resolvedReason)}{/if}
                · filed <span title={dateTime(prior.createdAt)}>{ago(prior.createdAt)}</span>
                {#if prior.resolvedAt}
                  · decided <span title={dateTime(prior.resolvedAt)}>{ago(prior.resolvedAt)}</span>
                {/if}
                {#if prior.resolvedBy}
                  by <a href={userLookupUrl(prior.resolvedBy)} class={LINK_CLASS}>moderator</a>
                {/if}
                <code class="text-dark-2">#{prior.id}</code>
              </p>
              {#if prior.internalNotes}
                <p class="m-0 mt-1 whitespace-pre-wrap">Note: {prior.internalNotes}</p>
              {/if}
              {#if prior.resolvedMessage}
                <p class="m-0 mt-1 whitespace-pre-wrap text-dark-2">
                  Told them: {prior.resolvedMessage}
                </p>
              {/if}
            </li>
          {/each}
        </ul>
      </TriageCard>
    {/if}
  {/snippet}
  {#snippet actions()}
    <div class="grid w-full gap-2">
      <p class="m-0 text-sm text-dark-2">{effect.text}</p>
      {#if effect.blocked}
        <p class="m-0 text-sm text-amber-300">{effect.blocked}</p>
      {/if}
      <RulingForm
        subject="appeal"
        {choices}
        action="?/resolve"
        enhancer={submit((form) =>
          form.get('status') === 'Approved' ? 'Appeal approved' : 'Appeal rejected'
        )}
        idPrefix="site-appeal-{row.id}"
        size="lg"
        kbd
        choiceDisabled={(v) => (v === 'Approved' ? effect.blocked : null)}
        bind:draft
      >
        {#snippet hidden()}
          <input type="hidden" name="appealId" value={row.id} />
        {/snippet}
        {#snippet extra()}
          <Label for="site-appeal-{row.id}-message" class="text-sm text-dark-2">
            Message to {name} (optional, shown to them as written)
          </Label>
          <Textarea
            id="site-appeal-{row.id}-message"
            name="resolvedMessage"
            bind:value={() => (draft.verdict ? (messages[draft.verdict] ?? '') : ''),
              (v) => {
                if (draft.verdict) messages[draft.verdict] = v;
              }}
            rows={2}
            maxlength={1000}
          />
        {/snippet}
      </RulingForm>
    </div>
  {/snippet}
</TriageDetailFrame>
