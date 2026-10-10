<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS } from '$lib/format';
  import type { Decision } from '$lib/abuse-decisions';
  import type { AbuseVerdict } from '$lib/abuse-verdicts';
  import VerdictControl from './VerdictControl.svelte';
  import ProseDisclosure from './ProseDisclosure.svelte';
  import { findingBullets, type RenderableFinding } from './finding-presentation';

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

  /**
   * 🔴 BUILT IN A PURE MODULE, NOT HERE. Every bullet is a label, a value and the separators between
   * them, and both of those are what a template gets wrong silently — so the list's content, order and
   * agreement are asserted by `finding-presentation.test.ts` rather than by nothing.
   */
  const bullets = $derived(findingBullets(decision));
</script>

<!-- 🔴 NAMED, BECAUSE EVERY CARD'S DISCLOSURE CARRIES THE SAME LABEL. A run is a page of these, so a
     screen reader listing the page's controls otherwise hears one identical summary N times with
     nothing saying which account it belongs to. `VerdictControl` already solves this class for its
     three buttons by putting the finding id in their `aria-describedby`; naming the region is the same
     fix one level up, and it keeps the label itself a constant the tests can pin. -->
<article
  aria-label="Finding for account {lead.userId}"
  class="border-dark-4 bg-dark-6 rounded-xl border p-5"
>
  <!-- 🔴 A `<dl>`, NOT A `<ul>` — AND A VERTICAL LIST, NOT A ROW OF CHIPS. These are term/value pairs,
       which is what `<dl>` is for and what keeps the label→value association for a screen reader; a
       `ul` of flex `li`s loses its list semantics in WebKit twice over (preflight's `list-style: none`
       plus `display: flex`). `RunCounters.svelte` beside this file renders the same shape the same way.
       Vertical because a moderator works down a page of cards deciding one at a time, and the facts
       that decide it used to sit on one wrapping line whose fields landed in a different place on
       every card. -->
  <dl class="mb-4 space-y-1 text-sm">
    {#each bullets as b (b.key)}
      <!-- 🔴 `gap-x-2` IS THE SEPARATOR BETWEEN TERM AND VALUE, deliberately, because a CSS gap cannot
           be trimmed. A space typed between the two elements is template whitespace and Svelte is free
           to collapse or drop it, which is the class of defect this board has shipped twice. Every
           separator INSIDE a value lives in the module instead. `gap-y-1` is not decoration either:
           without it a value that wraps to a second flex line sits flush against the first. -->
      <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <dt class="text-dark-2 shrink-0">{b.label}</dt>
        <dd class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          {#if b.badge}
            <Badge variant={b.badge.variant}>{b.badge.text}</Badge>
          {/if}
          <!-- 🔴 RENDERED ALONGSIDE THE BADGE, NEVER INSTEAD OF IT. A branch that drew one OR the
               other would silently drop half of any bullet carrying both — which the action bullet
               now does, because a Badge cannot wrap and an action name is producer free text.
               `?q=`, not `?userId=` — an unknown param is dropped, landing the moderator on an empty
               search.
               🔴 And the SECTION is named rather than left to the bare route's redirect, which lands
               on Basic. Following this link used to arrive at a page with ~20 panels and nothing
               about abuse detection; mod-activity is where AbuseFindingsPanel renders, so the finding
               a moderator clicked is on the page they land on.
               🔴 KEYED ON THE FINDING'S PRIMARY KEY, NEVER ON `userId` — see `BulletLink`. Two
               findings for one account in one run are permitted by the wire contract and land in the
               same cluster, and a duplicate key is a hard Svelte error in production, not a
               mis-wired node. -->
          {#if b.text || b.links.length > 0 || b.tail}
            <span class="min-w-0 break-words"
              >{b.text}{#each b.links as l (l.key)}{l.prefix}<a
                  class={LINK_CLASS}
                  href="/retool/user-lookup/mod-activity?q={l.userId}">{l.userId}</a
                >{/each}{b.tail}</span
            >
          {/if}
        </dd>
      </div>
    {/each}
  </dl>

  <!-- 🔴 THE LABEL CARRIES AN OBLIGATION AND MUST KEEP IT. Collapsing the reason is what the operator
       asked for, and some producers close a reason with a caveat that DECIDES the ruling — at least one
       tells the reader the flagged behaviour may be legitimate and to check the underlying content
       before acting. Those reasons are written outside this repo, so the only thing this board can
       promise is that the reader is told the text is a prerequisite. Naming it "Details" would put
       that prerequisite behind a shrug. -->
  <!-- 🔴 `{#key}` BECAUSE `<details>` HOLDS ITS OPEN STATE IN THE DOM AND NOTHING ELSE RESETS IT. A
       decision id is `group:<groupKey>` and is NOT scoped by run, so the same id can recur across runs
       and Svelte then reuses this card — leaving a disclosure a moderator opened on one run expanded on
       the next, which is the wall of prose this change exists to remove, re-introduced. Keyed on the
       lead finding's PK, which changes whenever the card is actually about a different row. -->
  {#key lead.id}
    <ProseDisclosure label="Full detector reason — read before ruling">
      <!-- 🔴 `whitespace-normal` IS AN OPT-IN THIS TEXT CANNOT DO WITHOUT. A finding's reason is a
           multi-sentence paragraph from the producer; in any container that does not wrap it renders on
           one line and paints over whatever is beside it. That is what the table cell it used to live
           in did. Pinned by `apps/moderator/src/routes/abuse/__tests__/prose-wrapping.test.ts`, which
           resolves the tag from this interpolation — so the text stays HERE rather than becoming a
           string prop on the disclosure. -->
      <p class="break-words whitespace-normal">{lead.reason}</p>
    </ProseDisclosure>
  {/key}

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
