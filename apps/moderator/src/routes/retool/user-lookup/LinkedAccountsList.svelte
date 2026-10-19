<script lang="ts">
  import { untrack } from 'svelte';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { LINK_CLASS, num, plural } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import {
    LINK_SIGNALS,
    bulkBanHref,
    gapLabel,
    initialBanSelection,
    isCorroborated,
    toggleId,
    type LinkSignal,
    type LinkedAccounts,
  } from '$lib/linked-accounts';
  import ListCard from './ListCard.svelte';

  let { result, accountId }: { result: LinkedAccounts; accountId: number } = $props();

  const LABEL: Record<LinkSignal, string> = {
    regIp: 'Sign-up IP',
    nearLogin: 'Logged in nearby',
    buzz: 'Buzz both ways',
    social: 'Same social link',
  };

  let selected = $state(untrack(() => initialBanSelection(result.accounts)));
  const href = $derived(bulkBanHref(selected));
  const offline = $derived(LINK_SIGNALS.filter((s) => result.status[s] !== 'ok'));
  const capped = $derived(LINK_SIGNALS.some((s) => result.truncated[s]));
  const strikesMissing = $derived(result.accounts.some((a) => a.strikes === null));
</script>

<ListCard
  title="Linked accounts"
  total={result.accounts.length}
  {capped}
  shown={12}
  hint="Other accounts tied to this one, most evidence first. Each chip is one kind of evidence; a single chip is common between unrelated accounts. Nothing is selected for Bulk Ban until you tick it."
  empty="No linked accounts found."
>
  {#snippet controls()}
    {#if offline.length}
      <p class="mb-3 text-xs text-amber-300">
        {#each offline as s, i (s)}
          {i ? ' · ' : ''}{LABEL[s]}: {result.status[s] === 'off'
            ? 'not configured'
            : 'could not load'}
        {/each}
      </p>
    {/if}
    {#if strikesMissing}
      <p class="mb-3 text-xs text-amber-300">Strike counts could not load.</p>
    {/if}
    {#if result.accounts.length}
      <div class="mb-3 flex flex-wrap items-center gap-3">
        <!-- A new tab, so the investigation stays open behind it. Bulk Ban asks for the reason and confirms. -->
        <Button
          size="xs"
          variant="outline"
          href={href ?? undefined}
          disabled={!href}
          target="_blank"
          rel="noopener"
        >
          Check {plural(selected.length, 'selected account')} in Bulk Ban
        </Button>
        <label class="flex items-center gap-2 text-xs text-dark-2">
          <Checkbox
            bind:checked={
              () => selected.includes(accountId), () => (selected = toggleId(selected, accountId))
            }
          />
          Include this account
        </label>
      </div>
    {/if}
  {/snippet}

  {#snippet children(limit: number)}
    <ul class="space-y-2 text-sm">
      {#each result.accounts.slice(0, limit) as acct (acct.userId)}
        <li
          class={cn(
            'flex gap-3 border-l-2 pl-2',
            isCorroborated(acct) ? 'border-amber-400' : 'border-transparent'
          )}
        >
          <Checkbox
            aria-label="Select {acct.username ?? `#${acct.userId}`} for Bulk Ban"
            class="mt-0.5"
            bind:checked={
              () => selected.includes(acct.userId), () => (selected = toggleId(selected, acct.userId))
            }
          />
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <a href={userLookupUrl(acct.userId)} class={LINK_CLASS}>
                {acct.username ?? `#${acct.userId}`}
              </a>
              {#if acct.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
              {#if acct.muted}<Badge variant="destructive">muted</Badge>{/if}
              {#if acct.strikes}
                <Badge variant="destructive">{plural(acct.strikes, 'strike')}</Badge>
              {/if}
              {#each LINK_SIGNALS.filter((s) => acct[s]) as s (s)}
                <Badge variant="outline">{LABEL[s]}</Badge>
              {/each}
            </div>
            <ul class="mt-0.5 space-y-0.5 text-xs text-dark-2">
              {#if acct.nearLogin}
                <li>
                  Logged in {gapLabel(acct.nearLogin.closestSeconds)} apart at closest, on
                  {plural(acct.nearLogin.ips.length, 'shared address', 'shared addresses')}
                  ({plural(acct.nearLogin.logins, 'login')})
                </li>
              {/if}
              {#if acct.buzz}
                <li>
                  #{acct.buzz.rank} Buzz counterparty: {num(acct.buzz.inCount)} in ({num(
                    acct.buzz.inAmount
                  )}), {num(acct.buzz.outCount)} out ({num(acct.buzz.outAmount)})
                </li>
              {/if}
              {#if acct.regIp}
                <li>Seen on this account's sign-up address: {acct.regIp.ips.join(', ')}</li>
              {/if}
              {#if acct.social}
                <li>Same link: <span class="break-all">{acct.social.url}</span></li>
              {/if}
            </ul>
          </div>
        </li>
      {/each}
    </ul>
  {/snippet}
</ListCard>

