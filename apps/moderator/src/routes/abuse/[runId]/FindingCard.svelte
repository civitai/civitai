<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS } from '$lib/format';
  import type { Decision } from '$lib/abuse-decisions';
  import type { AbuseVerdict } from '$lib/abuse-verdicts';
  import VerdictControl from './VerdictControl.svelte';
  import { moreMembersLabel, plural, type RenderableFinding } from './finding-presentation';

  let {
    decision,
    shown,
    stored,
    viewerId,
    canRule,
    submit,
  }: {
    decision: Decision<RenderableFinding>;
    shown: AbuseVerdict | 'mixed' | null;
    stored: AbuseVerdict | 'mixed' | null;
    viewerId: number | null;
    canRule: boolean;
    submit: (verdict: AbuseVerdict) => SubmitFunction;
  } = $props();

  const lead = $derived(decision.lead);

  // Two digits, not a percentage. These are the producer's own 0..1 scores and are NOT comparable
  // across detectors — rendering "94%" invites exactly the cross-detector ranking that would be
  // meaningless, and a bare decimal reads as the raw number it is.
  const confidence = $derived(lead.confidence.toFixed(2));

  /** A few members, named. Not all of them: the point of collapsing is that the list is long. */
  const EXAMPLES = 4;
  const others = $derived(decision.members.length - 1);
  const named = $derived(decision.members.slice(1, EXAMPLES + 1));
</script>

<article class="border-dark-4 bg-dark-6 rounded-xl border p-5">
  <div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
    <!-- 🔴 BOTH FIGURES ARE THE PRODUCER'S SELF-REPORT, never cross-checked against the action log,
         and both say so. Without the word this board reads as independent confirmation that
         something was done, when it is an input to a human decision and nothing more. -->
    {#if lead.actioned}
      <Badge variant="destructive">Acted (reported): {lead.action}</Badge>
    {:else}
      <!-- "No" is the common and important case: detected, scored, deliberately left alone. It is
           spelled out rather than shown as a blank, which would read as missing data. -->
      <Badge variant="secondary">Not acted on (reported)</Badge>
    {/if}
    <span class="text-dark-2 text-sm">Confidence (reported) {confidence}</span>
    <span class="text-dark-2 text-sm">
      Account
      <!-- `?q=`, not `?userId=` — an unknown param is dropped, landing the moderator on an empty
           search.
           🔴 And the SECTION is named rather than left to the bare route's redirect, which lands on
           Basic. Following this link used to arrive at a page with ~20 panels and nothing about
           abuse detection; mod-activity is where AbuseFindingsPanel renders, so the finding a
           moderator clicked is on the page they land on. -->
      <a class={LINK_CLASS} href="/retool/user-lookup/mod-activity?q={lead.userId}">{lead.userId}</a>
    </span>
  </div>

  {#if others > 0}
    <!-- The SIZE first, because it is what changes the decision: ruling one account and ruling
         eleven are different acts. The examples follow so the sentence is checkable rather than a
         number to be taken on trust. -->
    <p class="text-dark-2 mb-3 text-xs">
      {plural(decision.members.length, 'account')}, ruled together —
      {#each named as m, i (m.id)}{i > 0 ? ', ' : ''}<a
          class={LINK_CLASS}
          href="/retool/user-lookup/mod-activity?q={m.userId}">{m.userId}</a
        >{/each}{moreMembersLabel(others, named.length)}
    </p>
  {/if}

  <!-- 🔴 `whitespace-normal` IS AN OPT-IN THIS TEXT CANNOT DO WITHOUT. A finding's reason is a
       multi-sentence paragraph from the producer; in any container that does not wrap it renders on
       one line and paints over whatever is beside it. That is what the table cell it used to live in
       did. Pinned by `__tests__/prose-wrapping.test.ts`. -->
  <p class="break-words whitespace-normal">{lead.reason}</p>

  <VerdictControl
    findingId={lead.id}
    {shown}
    {stored}
    verdictBy={lead.verdictBy}
    verdictAt={lead.verdictAt}
    {viewerId}
    {canRule}
    {submit}
  />
</article>
