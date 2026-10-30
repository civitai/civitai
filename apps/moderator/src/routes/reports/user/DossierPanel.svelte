<script lang="ts">
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { SSR_PENDING } from '$lib/ssr-pending';
  import { fetchJson } from '$lib/fetch-json';
  import { LINK_CLASS, num, plural, type Jsonified } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import type { Dossier } from '$lib/server/dossier.service';

  // Client-fetched so the slow ClickHouse reads do not block the profile beside it. Sized by its
  // container, not the viewport: beside the queue it can be a narrow column on a wide screen.
  let { suspectId }: { suspectId: number } = $props();

  type Data = (Jsonified<Dossier> & { abuseShown: boolean }) | null;
  const dossier = $derived(
    browser ? fetchJson<Data>(`/api/user-dossier/${suspectId}`) : (SSR_PENDING as Promise<Data>)
  );

  const pct = (value: number) => `${Math.round(value * 100)}%`;
  const statusTone = (status: string) =>
    status === 'banned' || status === 'deleted' ? 'destructive' : 'secondary';
</script>

<section class="@container mt-6 border-t border-dark-4 pt-4">
  <h3 class="mb-3 text-sm font-semibold text-white">Dossier</h3>
  {#await dossier}
    <p class="text-sm text-dark-2">Building the dossier…</p>
  {:then d}
    {#if !d}
      <p class="text-sm text-dark-2">No account to summarise.</p>
    {:else}
      <dl class="grid gap-x-6 gap-y-3 text-sm @md:grid-cols-2">
        <div>
          <dt class="text-xs text-dark-2">Account</dt>
          <dd class="text-dark-0">
            {#if d.account}
              {num(d.account.ageDays)} days old
              {#if d.account.instantVerify}<Badge variant="outline">verified instantly</Badge>{/if}
              {#if d.account.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
              {#if d.account.muted}<Badge variant="destructive">muted</Badge>{/if}
            {:else}
              <span class="text-dark-2">unavailable</span>
            {/if}
          </dd>
        </div>

        <div>
          <dt class="text-xs text-dark-2">Images</dt>
          <dd class="text-dark-0">
            {#if d.images}
              {num(d.images.total)}
              {#if d.images.byLevel.length}
                <span class="text-dark-2">
                  ·
                  {d.images.byLevel.map((l) => `${l.level} ${num(l.count)}`).join(', ')}
                  {#if d.images.sampled < d.images.total}(newest {num(d.images.sampled)}){/if}
                </span>
              {/if}
              <div class="text-xs text-dark-2">
                {num(d.images.blocked)} blocked · {num(d.images.tosFlagged)} ToS-flagged ·
                {d.images.removedTos === null ? '?' : num(d.images.removedTos)} removed for ToS
              </div>
            {:else}
              <span class="text-dark-2">unavailable</span>
            {/if}
          </dd>
        </div>

        <div>
          <dt class="text-xs text-dark-2">Prior reports on the account</dt>
          <dd class="text-dark-0">
            {#if d.reports}
              {@const entries = Object.entries(d.reports.byStatus)}
              {entries.length
                ? entries.map(([status, n]) => `${num(n)} ${status.toLowerCase()}`).join(' · ')
                : 'none'}
              {#if d.reports.actionedRate !== null}
                <span class="text-dark-2">· {pct(d.reports.actionedRate)} actioned</span>
              {/if}
              {#if d.reports.automated}
                <div class="text-xs text-dark-2">+{num(d.reports.automated)} automated</div>
              {/if}
            {:else}
              <span class="text-dark-2">unavailable</span>
            {/if}
          </dd>
        </div>

        <div>
          <dt class="text-xs text-dark-2">Enforcement</dt>
          <dd class="text-dark-0">
            {#if d.enforcement}
              {plural(d.enforcement.strikesAllTime, 'strike')}
              {#if d.enforcement.activeStrikes}
                <span class="text-dark-2">({num(d.enforcement.activeStrikes)} active)</span>
              {/if}
              · {plural(d.enforcement.mutes, 'mute')} · {plural(d.enforcement.bans, 'ban')}
            {:else}
              <span class="text-dark-2">unavailable</span>
            {/if}
            {#if d.abuseShown && !d.abuse}
              <div class="text-xs text-dark-2">detector findings unavailable</div>
            {:else if d.abuse?.count}
              <div class="text-xs">
                <a href={userLookupUrl(suspectId)} class={LINK_CLASS}>
                  {num(d.abuse.count)}{d.abuse.truncated ? '+' : ''} abuse
                  {d.abuse.count === 1 && !d.abuse.truncated ? 'finding' : 'findings'}
                </a>
              </div>
            {/if}
          </dd>
        </div>

        <div class="@md:col-span-2">
          <dt class="text-xs text-dark-2">
            Reactions received{d.breadth ? `, last ${d.breadth.days} days` : ''}
          </dt>
          <dd class="text-dark-0">
            {#if d.breadth}
              {#if d.breadth.reactions}
                {num(d.breadth.reactions)} from {num(d.breadth.reactors)}
                {d.breadth.reactors === 1 ? 'account' : 'accounts'}
                <span class="text-dark-2">
                  · top 10 give {pct(d.breadth.top10Share)}, top 20 give {pct(d.breadth.top20Share)}
                </span>
              {:else}
                none
              {/if}
            {:else}
              <span class="text-dark-2">unavailable</span>
            {/if}
          </dd>
        </div>
      </dl>

      <h4 class="mt-4 mb-2 text-xs font-semibold text-white">
        Accounts on its login or reaction addresses
      </h4>
      {#if !d.linked}
        <p class="text-sm text-dark-2">Could not read the addresses.</p>
      {:else if d.linked.accounts.length === 0}
        <p class="text-sm text-dark-2">None in the last {d.linked.days} days of reactions or any login.</p>
      {:else}
        <p class="mb-2 text-xs text-dark-2">
          {num(d.linked.totals.login)} by login · {num(d.linked.totals.reaction)} by reaction{d.linked
            .truncated
            ? ' (lower bound)'
            : ''}. Narrowest address first: “2 on it” means only these two accounts.
        </p>
        <ul class="space-y-1 text-sm">
          {#each d.linked.accounts as acct (acct.userId)}
            <li class="flex flex-wrap items-baseline gap-x-2">
              <a href={userLookupUrl(acct.userId)} class={LINK_CLASS}>
                {acct.username ?? `#${acct.userId}`}
              </a>
              {#if acct.status !== 'active'}
                <Badge variant={statusTone(acct.status)}>{acct.status}</Badge>
              {/if}
              {#if acct.muted}<Badge variant="destructive">muted</Badge>{/if}
              {#if acct.strikes}<Badge variant="destructive">{plural(acct.strikes, 'strike')}</Badge>{/if}
              {#if acct.reaction.length}
                <Badge variant="outline">reacts from {plural(acct.reaction.length, 'address', 'addresses')}</Badge>
              {/if}
              {#if acct.login.length}
                <Badge variant="outline">logs in from {plural(acct.login.length, 'address', 'addresses')}</Badge>
              {/if}
              <span class="text-xs text-dark-2">{num(acct.narrowest)} on it</span>
            </li>
          {/each}
        </ul>
        {#if d.linked.matched > d.linked.accounts.length}
          <p class="mt-2 text-xs text-dark-2">
            +{num(d.linked.matched - d.linked.accounts.length)} more — ask the assistant for the full list.
          </p>
        {/if}
      {/if}
    {/if}
  {:catch}
    <p class="text-sm text-dark-2">Could not build the dossier.</p>
  {/await}
</section>
