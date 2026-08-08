<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { LINK_CLASS } from '$lib/format';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { FormResult } from './form-result';
  import { safeHref, type Signals } from './signals';
  import { LINK_TYPES } from './enforcement-options';

  let {
    signals,
    userId,
    canAct,
    form,
    onSubmit,
    submitting,
  }: {
    signals: Promise<Signals> | null;
    userId: number;
    canAct: boolean;
    form: FormResult;
    onSubmit: SubmitFunction;
    submitting: boolean;
  } = $props();

  const error = $derived(form?.scope === 'socials' ? form.error : null);

  let adding = $state(false);
  let linkType = $state('Social');
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="mb-3 flex items-baseline justify-between gap-3">
    <h3 class="text-sm font-semibold text-white">Social links</h3>
    {#if canAct && !adding}
      <Button size="sm" onclick={() => (adding = true)}>Add link</Button>
    {/if}
  </div>

  {#if error}
    <div
      class="mb-3 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
      role="alert"
    >
      {error}
    </div>
  {/if}

  {#if adding}
    <form method="POST" action="?/addSocial" use:enhance={onSubmit} class="mb-3">
      <input type="hidden" name="userId" value={userId} />
      <div class="flex flex-wrap items-end gap-2">
        <Input name="url" placeholder="https://…" class="min-w-48 flex-1" required />
        <Select.Root type="single" name="type" bind:value={linkType}>
          <Select.Trigger class="w-36">{linkType}</Select.Trigger>
          <Select.Content>
            {#each LINK_TYPES as t (t)}
              <Select.Item value={t}>{t}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
        <Button type="submit" size="sm" disabled={submitting}>Add link</Button>
        <Button type="button" size="sm" variant="outline" onclick={() => (adding = false)}>
          Cancel
        </Button>
      </div>
    </form>
  {/if}

  {#await signals}
    <p class="text-sm text-dark-2">Loading links…</p>
  {:then result}
    {#if result}
      <div class="grid gap-5 lg:grid-cols-2">
        <div>
          <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
            On this account ({result.socials.links.length})
          </h4>
          {#if result.socials.links.length === 0}
            <p class="text-sm text-dark-2">None.</p>
          {:else}
            <ul class="space-y-1 text-sm">
              {#each result.socials.links as link (link.id)}
                <li class="flex flex-wrap items-baseline gap-x-2">
                  <Badge variant="secondary">{link.type}</Badge>
                  {#if safeHref(link.url)}
                    <a
                      href={safeHref(link.url)}
                      target="_blank"
                      rel="noreferrer noopener"
                      class="break-all {LINK_CLASS}"
                    >
                      {link.url}
                    </a>
                  {:else}
                    <span class="break-all text-dark-0">{link.url}</span>
                  {/if}
                  {#if canAct}
                    <form method="POST" action="?/removeSocial" use:enhance={onSubmit}>
                      <input type="hidden" name="id" value={link.id} />
                      <input type="hidden" name="userId" value={userId} />
                      <button type="submit" class="text-xs {LINK_CLASS}">remove</button>
                    </form>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <div>
          <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
            Accounts sharing them ({result.socials.accounts.length}{result.socials.truncated
              ? '+'
              : ''})
          </h4>
          {#if result.socials.accounts.length === 0}
            <p class="text-sm text-dark-2">None found.</p>
          {:else}
            <ul class="space-y-1 text-sm">
              {#each result.socials.accounts as acct (acct.userId)}
                <li class="flex flex-wrap items-baseline gap-x-2">
                  <a href="?q={acct.userId}" class={LINK_CLASS}>
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
                  <span class="truncate text-xs text-dark-2">{acct.url}</span>
                </li>
              {/each}
            </ul>
            {#if result.socials.truncated}
              <p class="mt-2 text-xs text-amber-300">
                Capped — more accounts share these links than are shown.
              </p>
            {/if}
          {/if}
        </div>
      </div>
    {/if}
  {:catch}
    <p class="text-sm text-red-300">Could not load social links.</p>
  {/await}
</section>
