<script lang="ts">
  import type { ReportActionGrants } from '$lib/report-queue';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import ImageEvidence from '$lib/components/report-queue/ImageEvidence.svelte';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { entityUrl, userLookupUrl } from '$lib/entity-url';
  import { entityReportUrl } from '$lib/entity-report-queues';
  import type { EntityEvidence } from '$lib/server/entity-queue-load';

  // A reported bounty, or a reported entry with the bounty it was submitted to — "used a pre-existing
  // model" and "wants a real person's likeness" are both claims about what the bounty asked for.
  let {
    evidence,
    can,
    civitaiUrl,
  }: {
    evidence: Extract<EntityEvidence, { kind: 'bounty' | 'bountyEntry' }>;
    can: ReportActionGrants;
    civitaiUrl: string;
  } = $props();

  const bounty = $derived(evidence.bounty);
  const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
</script>

{#snippet bountyFacts(b: NonNullable<typeof bounty>)}
  <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
    <dt class="text-muted-foreground">Asks for</dt>
    <dd class="m-0 flex flex-wrap items-center gap-2">
      {b.type}
      {#if b.poi}<Badge variant="destructive">real person</Badge>{/if}
      {#if b.complete}<Badge variant="secondary">complete</Badge>{/if}
      {#if b.refunded}<Badge variant="secondary">refunded</Badge>{/if}
    </dd>
    <dt class="text-muted-foreground">Runs</dt>
    <dd class="m-0">{day(b.startsAt)} to {day(b.expiresAt)}</dd>
    <dt class="text-muted-foreground">Entries</dt>
    <dd class="m-0">{b.entryMode}, {b.mode}</dd>
    <dt class="text-muted-foreground">Shown</dt>
    <dd class="m-0">{b.availability} · rated {getBrowsingLevelLabel(b.nsfwLevel)}</dd>
    <dt class="text-muted-foreground">Description</dt>
    <dd class="m-0 wrap-break-word">
      {#if b.description}
        <!-- As text: author-written markup, rendered in a moderator's session. -->
        <div class="max-h-80 overflow-y-auto whitespace-pre-wrap">{b.description.text}</div>
        {#if b.description.truncated}
          <a href={entityUrl(civitaiUrl, 'bounty', b.id)} target="_blank" rel="noreferrer" class="{LINK_CLASS} text-xs">
            The rest is on the site
          </a>
        {/if}
      {:else}
        —
      {/if}
    </dd>
  </dl>
{/snippet}

{#if evidence.kind === 'bounty' && bounty}
  {@render bountyFacts(bounty)}
  <dl class="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
    <dt class="text-muted-foreground">Pool</dt>
    <dd class="m-0">
      {#each evidence.prize as p, i (p.currency)}
        {i ? ' · ' : ''}{num(p.amount)} {p.currency.toLowerCase()} from {num(p.benefactors)}
        {p.benefactors === 1 ? 'backer' : 'backers'}
      {:else}
        —
      {/each}
      · {num(evidence.entries)} {evidence.entries === 1 ? 'entry' : 'entries'}
    </dd>
  </dl>
  {#if evidence.images}
    <section aria-labelledby="bounty-images" class="mt-5 flex flex-col gap-2">
      <h3 id="bounty-images" class="m-0 text-sm font-semibold">
        Reference images <span class="font-normal text-muted-foreground">· {num(evidence.images.total)}</span>
      </h3>
      <ImageEvidence
        images={evidence.images.items}
        {can}
        {civitaiUrl}
        empty="This bounty has no images."
        truncated={evidence.images.truncated}
      />
    </section>
  {/if}
{:else if evidence.kind === 'bountyEntry' && evidence.entry}
  {@const e = evidence.entry}
  <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
    <dt class="text-muted-foreground">Submitted</dt>
    <dd class="m-0 flex flex-wrap items-center gap-2">
      {dateTime(e.createdAt)}
      {#if e.awarded}<Badge variant="secondary">awarded</Badge>{/if}
      {#if e.locked}<Badge variant="secondary">locked</Badge>{/if}
    </dd>
    <dt class="text-muted-foreground">Rated</dt>
    <dd class="m-0">{getBrowsingLevelLabel(e.nsfwLevel)}</dd>
    <dt class="text-muted-foreground">Notes</dt>
    <dd class="m-0 whitespace-pre-wrap wrap-break-word">{e.description?.text ?? '—'}</dd>
  </dl>
  {#if evidence.images}
    <section aria-labelledby="entry-images" class="mt-5 flex flex-col gap-2">
      <h3 id="entry-images" class="m-0 text-sm font-semibold">
        Submitted images <span class="font-normal text-muted-foreground">· {num(evidence.images.total)}</span>
      </h3>
      <ImageEvidence
        images={evidence.images.items}
        {can}
        {civitaiUrl}
        empty="This entry has no images."
        truncated={evidence.images.truncated}
      />
    </section>
  {/if}
  {#if bounty}
    <section aria-labelledby="entry-bounty" class="mt-5 flex flex-col gap-2 rounded-lg border p-3">
      <h3 id="entry-bounty" class="m-0 text-sm font-semibold">
        Submitted to
        <a href={entityUrl(civitaiUrl, 'bounty', bounty.id)} target="_blank" rel="noreferrer" class={LINK_CLASS}>
          {bounty.name}
        </a>
        {#if bounty.userId != null}
          <span class="font-normal text-muted-foreground">
            by <a href={userLookupUrl(bounty.username ?? bounty.userId)} class={LINK_CLASS}>
              {bounty.username ?? `#${bounty.userId}`}
            </a>
          </span>
        {/if}
        <a href={entityReportUrl('bounty', bounty.id)} class="{LINK_CLASS} ml-1 text-xs font-normal">
          its reports
        </a>
      </h3>
      {@render bountyFacts(bounty)}
    </section>
  {/if}
{/if}
