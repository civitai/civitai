<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { civitaiUrl } from '$lib/model-url';
  import CreatedCodes from './CreatedCodes.svelte';
  import { groupGiftLinks, type GiftGroup } from './gift-links';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const groups = $derived(groupGiftLinks(data.items));
  const created = $derived(form && 'created' in form ? form.created : null);
  // A mature model's gift link opens on .red, like every other link out of the Studio.
  const giftBase = $derived(civitaiUrl('gift/', data.version));

  function status(g: GiftGroup) {
    const revoked = g.kind === 'link' ? !!g.link.revokedAt : g.revoked === g.total;
    const expiresAt = g.kind === 'link' ? g.link.expiresAt : g.expiresAt;
    if (revoked) return 'Revoked';
    if (expiresAt && new Date(expiresAt) <= new Date()) return 'Expired';
    return 'Active';
  }
  const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString() : 'Never');
</script>

<svelte:head><title>Gift links · {data.version.modelName}</title></svelte:head>

<div class="mx-auto flex max-w-3xl flex-col gap-5 p-5">
  <div>
    <a href="/models" class="text-sm text-dark-2 hover:text-white">← Models</a>
    <h1 class="mt-1 text-xl font-semibold text-white">Gift links</h1>
    <p class="text-sm text-dark-2">
      {data.version.modelName} · {data.version.name}. A claim gives free access to this version.
      Revoking stops new claims; people who already claimed keep access.
    </p>
  </div>

  {#if form && 'error' in form && form.error}
    <p class="rounded-md border border-red-5/40 bg-red-5/10 p-3 text-sm text-red-4">{form.error}</p>
  {/if}
  {#if created}
    <CreatedCodes codes={created.codes} {giftBase} />
  {/if}

  <div class="grid gap-5 sm:grid-cols-2">
    <form method="POST" action="?/createLink" use:enhance class="cs-panel flex flex-col gap-3 p-5">
      <h2 class="font-medium text-white">Shareable link</h2>
      <div><Label for="maxRedemptions">Max claims (blank = no limit)</Label>
        <Input id="maxRedemptions" name="maxRedemptions" type="number" min="1" /></div>
      <div><Label for="link-expires">Expires (optional)</Label>
        <Input id="link-expires" name="expiresAt" type="date" /></div>
      <div><Label for="link-label">Note (optional)</Label>
        <Input id="link-label" name="label" maxlength={100} /></div>
      <Button type="submit">Create link</Button>
    </form>

    <form method="POST" action="?/mint" use:enhance class="cs-panel flex flex-col gap-3 p-5">
      <h2 class="font-medium text-white">Single-use codes</h2>
      <div><Label for="count">How many (up to 500)</Label>
        <Input id="count" name="count" type="number" min="1" max="500" required /></div>
      <div><Label for="mint-expires">Expires (optional)</Label>
        <Input id="mint-expires" name="expiresAt" type="date" /></div>
      <div><Label for="mint-label">Note (optional)</Label>
        <Input id="mint-label" name="label" maxlength={100} /></div>
      <Button type="submit">Mint codes</Button>
    </form>
  </div>

  <section class="cs-panel p-0">
    {#if data.listError}
      <p class="p-5 text-sm text-dark-2">{data.listError}</p>
    {:else if groups.length === 0}
      <p class="p-5 text-sm text-dark-2">No gift links yet.</p>
    {:else}
      <ul class="divide-y divide-dark-4">
        {#each groups as g (g.kind === 'link' ? `l${g.link.id}` : `b${g.batchId}`)}
          {@const st = status(g)}
          <li class="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
            <span class="min-w-0 flex-1 text-dark-0">
              {#if g.kind === 'link'}
                Link ···{g.link.codeHint}{g.link.label ? ` · ${g.link.label}` : ''}
              {:else}
                {g.total} codes{g.label ? ` · ${g.label}` : ''}
              {/if}
            </span>
            <span class="text-dark-2">
              {#if g.kind === 'link'}
                {g.link.redemptionCount}{g.link.maxRedemptions ? ` / ${g.link.maxRedemptions}` : ''} claimed
              {:else}
                {g.redeemed} / {g.total} claimed
              {/if}
              · expires {fmt(g.kind === 'link' ? g.link.expiresAt : g.expiresAt)}
            </span>
            <Badge variant="outline">{st}</Badge>
            {#if st === 'Active'}
              <form method="POST" action="?/revoke" use:enhance>
                <input
                  type="hidden"
                  name={g.kind === 'link' ? 'id' : 'batchId'}
                  value={g.kind === 'link' ? g.link.id : g.batchId}
                />
                <button type="submit" class="text-sm text-red-4 hover:underline">Revoke</button>
              </form>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>
