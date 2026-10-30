<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { LINK_CLASS, num } from '$lib/format';
  import { bulkBanUrl, userLookupUrl } from '$lib/entity-url';

  /** The accounts sharing an address with this one, and the hand-off to Bulk Ban. */
  let {
    accountId,
    accounts,
    truncated,
    shown = 12,
  }: {
    /** The account being looked at. It goes into the ban list too: it is the reason the list exists,
     *  and leaving it out meant pasting it in by hand. */
    accountId: number;
    /** `ip` is null for a viewer who could not read the addresses in User Lookup. */
    accounts: {
      userId: number;
      username: string | null;
      bannedAt: string | null;
      muted: boolean | null;
      strikes: number;
      ip: string | null;
      type: string;
    }[];
    truncated: boolean;
    shown?: number;
  } = $props();

  // The list is capped for reading; the ids are not. One row per shared address, so the same account
  // can appear more than once and the set is deduped before it is any use as a ban list.
  const ids = $derived([...new Set([accountId, ...accounts.map((a) => a.userId)])]);
</script>

{#if accounts.length === 0}
  <p class="text-sm text-dark-2">None found.</p>
{:else}
  <ul class="space-y-1 text-sm">
    {#each accounts.slice(0, shown) as acct (`${acct.userId}:${acct.ip}:${acct.type}`)}
      <li class="flex flex-wrap items-baseline gap-x-2">
        <a href={userLookupUrl(acct.userId)} class={LINK_CLASS}>
          {acct.username ?? `#${acct.userId}`}
        </a>
        {#if acct.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
        {#if acct.muted}<Badge variant="destructive">muted</Badge>{/if}
        {#if acct.strikes > 0}
          <Badge variant="destructive">
            {acct.strikes}
            {acct.strikes === 1 ? 'strike' : 'strikes'}
          </Badge>
        {/if}
        {#if acct.ip}<code class="text-xs text-dark-2">{acct.ip}</code>{/if}
      </li>
    {/each}
  </ul>
  {#if accounts.length > shown}
    <p class="mt-2 text-xs text-dark-2">+{num(accounts.length - shown)} more</p>
  {/if}
  {#if truncated}
    <p class="mt-2 text-xs text-amber-300">
      Capped — this address is shared widely, so matches here may be coincidental.
    </p>
  {/if}

  <!-- This list is where a ring gets identified and Bulk Ban is where it gets dealt with. A new tab, so
       the investigation stays open behind it. -->
  <div class="mt-3 flex flex-wrap items-center gap-2">
    <Button
      size="xs"
      variant="outline"
      href={bulkBanUrl(ids)}
      target="_blank"
      rel="noopener"
    >
      Check {num(ids.length)} in Bulk Ban
    </Button>
  </div>
  <details class="mt-2">
    <summary class="cursor-pointer text-xs text-dark-2">
      Copy {num(ids.length)} unique ID{ids.length === 1 ? '' : 's'}
    </summary>
    <Textarea
      readonly
      rows={4}
      class="mt-2 max-h-40 overflow-y-auto font-mono text-xs"
      value={ids.join('\n')}
    />
  </details>
{/if}
