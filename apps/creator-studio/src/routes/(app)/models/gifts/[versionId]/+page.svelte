<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import * as Alert from '@civitai/ui/components/ui/alert/index.js';
  import { ConfirmButton } from '@civitai/ui/components/confirm/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { GIFT_LINK_DEFAULT_REDEMPTIONS, GIFT_LINK_MAX_REDEMPTIONS } from '$lib/gift-links';
  import { civitaiUrl } from '$lib/model-url';
  import ClaimsList from './ClaimsList.svelte';
  import CreatedCodes from './CreatedCodes.svelte';
  import { batchStatus, endOfLocalDay, linkStatus } from '../gift-links';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // Not derived from `form`: the next action replaces it, and the codes can't be fetched again. Seeded
  // from it for a post made before hydration.
  // svelte-ignore state_referenced_locally
  let created = $state<string[] | null>(
    form && 'created' in form ? (form.created?.codes ?? null) : null
  );
  let pending = $state<string | null>(null);
  // svelte-ignore state_referenced_locally
  let failure = $state<{ action: string; message: string } | null>(
    form && 'error' in form ? { action: 'page', message: String(form.error) } : null
  );

  // A mature model's gift link opens on .red, like every other link out of the Studio.
  const giftBase = $derived(civitaiUrl('gift/', data.version));
  const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString() : 'Never');

  function submit(action: string): SubmitFunction {
    return ({ formData }) => {
      const expiresAt = formData.get('expiresAt');
      if (typeof expiresAt === 'string') formData.set('expiresAt', endOfLocalDay(expiresAt));
      pending = action;
      failure = null;
      return async ({ result, update }) => {
        pending = null;
        if (result.type === 'success' && result.data?.created) created = result.data.created.codes;
        if (result.type === 'failure')
          failure = { action, message: String(result.data?.error ?? 'Request failed.') };
        await update({ reset: result.type === 'success' });
      };
    };
  }
</script>

<svelte:head><title>Gift links · {data.version.modelName}</title></svelte:head>

{#snippet actionError(action: string)}
  {#if failure?.action === action}
    <p class="text-sm text-red-4">{failure.message}</p>
  {/if}
{/snippet}

<div class="mx-auto flex max-w-3xl flex-col gap-5 p-5">
  <div>
    <a href="/models/gifts" class="text-sm text-dark-2 hover:text-white">← Gift links</a>
    <h1 class="mt-1 text-xl font-semibold text-white">Gift links</h1>
    <p class="text-sm text-dark-2">
      {data.version.modelName} · {data.version.name}. A claim gives free access to this version.
      Revoking stops new claims; people who already claimed keep access.
    </p>
  </div>

  {@render actionError('page')}
  {#if created}
    <CreatedCodes codes={created} {giftBase} ondismiss={() => (created = null)} />
  {/if}

  <div class="grid gap-5 sm:grid-cols-2">
    <form
      method="POST"
      action="?/createLink"
      use:enhance={submit('createLink')}
      class="cs-panel flex flex-col gap-3 p-5"
    >
      <div>
        <h2 class="font-medium text-white">Multi-use link</h2>
        <p class="text-sm text-dark-2">
          One link you can post anywhere. Each signed-in person can claim it once, until it reaches
          its claim limit or expires.
        </p>
      </div>
      <div>
        <Label for="maxRedemptions">Max claims (up to {GIFT_LINK_MAX_REDEMPTIONS})</Label>
        <Input
          id="maxRedemptions"
          name="maxRedemptions"
          type="number"
          min="1"
          max={GIFT_LINK_MAX_REDEMPTIONS}
          value={GIFT_LINK_DEFAULT_REDEMPTIONS}
          required
        />
      </div>
      <div>
        <Label for="link-expires">Expires (optional)</Label>
        <Input id="link-expires" name="expiresAt" type="date" />
      </div>
      <div>
        <Label for="link-label">Note (optional)</Label>
        <Input id="link-label" name="label" maxlength={100} />
      </div>
      {@render actionError('createLink')}
      <Button type="submit" disabled={!!pending}>
        {pending === 'createLink' ? 'Creating…' : 'Create link'}
      </Button>
    </form>

    <form
      method="POST"
      action="?/mint"
      use:enhance={submit('mint')}
      class="cs-panel flex flex-col gap-3 p-5"
    >
      <div>
        <h2 class="font-medium text-white">Single-use links</h2>
        <p class="text-sm text-dark-2">
          A set of links that each work once. Send a different one to each person; copy them or
          download a CSV right after you mint them.
        </p>
      </div>
      <div>
        <Label for="count">How many (up to 500)</Label>
        <Input id="count" name="count" type="number" min="1" max="500" required />
      </div>
      <div>
        <Label for="mint-expires">Expires (optional)</Label>
        <Input id="mint-expires" name="expiresAt" type="date" />
      </div>
      <div>
        <Label for="mint-label">Note (optional)</Label>
        <Input id="mint-label" name="label" maxlength={100} />
      </div>
      {@render actionError('mint')}
      <Button type="submit" disabled={!!pending}>
        {pending === 'mint' ? 'Minting…' : 'Mint links'}
      </Button>
    </form>
  </div>

  {#if data.listError}
    <Alert.Root variant="destructive">
      <Alert.Title>Couldn't load your gift links</Alert.Title>
      <Alert.Description>{data.listError}</Alert.Description>
    </Alert.Root>
  {:else if data.gifts.links.length === 0 && data.gifts.batches.length === 0}
    <p class="text-sm text-dark-2">No gift links yet.</p>
  {:else}
    <section class="cs-panel p-0">
      <div class="px-5 pt-3 empty:hidden">{@render actionError('revoke')}</div>
      <ul class="divide-y divide-dark-4">
        {#each data.gifts.links as link (`l${link.id}`)}
          {@const st = linkStatus(link)}
          <li class="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
            <span class="min-w-0 flex-1 text-dark-0">
              Multi-use link ···{link.codeHint}{link.label ? ` · ${link.label}` : ''}
            </span>
            <span class="text-dark-2">
              {link.redemptionCount}{link.maxRedemptions ? ` / ${link.maxRedemptions}` : ''} claimed ·
              expires {fmt(link.expiresAt)}
            </span>
            <Badge variant="outline">{st}</Badge>
            {#if st === 'Active'}
              <form method="POST" action="?/revoke" use:enhance={submit('revoke')}>
                <input type="hidden" name="id" value={link.id} />
                <ConfirmButton
                  label="Revoke"
                  title="Revoke this link?"
                  description="Nobody new can claim it. People who already claimed keep access."
                  disabled={!!pending}
                />
              </form>
            {/if}
            {#if link.redemptionCount > 0}
              <ClaimsList versionId={data.version.id} target={{ giftId: link.id }} />
            {/if}
          </li>
        {/each}
        {#each data.gifts.batches as batch (`b${batch.batchId}`)}
          {@const st = batchStatus(batch)}
          <li class="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
            <span class="min-w-0 flex-1 text-dark-0">
              {batch.total} single-use links{batch.label ? ` · ${batch.label}` : ''}
            </span>
            <span class="text-dark-2">
              {batch.claimed} / {batch.total} claimed · expires {fmt(batch.expiresAt)}
            </span>
            <Badge variant="outline">{st}</Badge>
            {#if st === 'Active'}
              <form method="POST" action="?/revoke" use:enhance={submit('revoke')}>
                <input type="hidden" name="batchId" value={batch.batchId} />
                <ConfirmButton
                  label="Revoke"
                  title="Revoke this batch?"
                  description={`Its ${batch.live} unclaimed links stop working. This can't be undone.`}
                  disabled={!!pending}
                />
              </form>
            {/if}
            {#if batch.claimed > 0}
              <ClaimsList versionId={data.version.id} target={{ batchId: batch.batchId }} />
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>
