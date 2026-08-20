<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import type { LayoutData } from './$types';
  import { dateTime, LINK_CLASS } from '$lib/format';
  import { FormState } from '$lib/form-state.svelte';

  type Subscription = NonNullable<LayoutData['result']>['subscription'];

  let {
    subscription,
    userId,
    paddleCustomerId,
    canAct,
    conflict = null,
  }: {
    subscription: Subscription;
    userId: number;
    paddleCustomerId: string | null;
    canAct: boolean;
    /** The account already holding the id that was submitted, when there is one. */
    conflict?: { id: number; username: string | null; paddleCustomerId: string } | null;
  } = $props();

  let linking = $state(false);

  const form = new FormState({
    reload: true,
    onSuccess: () => (linking = false),
  });
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-3 text-sm font-semibold text-white">Subscription</h3>

  {#if !subscription}
    <p class="text-sm text-dark-2">No subscription on record.</p>
  {:else}
    <div class="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span class="font-medium text-white">{subscription.productName ?? 'Unknown plan'}</span>
      <!-- Annual against monthly is the fact a refund amount turns on, so it sits with the plan name
           rather than in the detail list below. -->
      {#if subscription.interval}
        <Badge variant="outline">{subscription.interval}ly</Badge>
      {/if}
      <Badge variant={subscription.status === 'active' ? 'secondary' : 'destructive'}>
        {subscription.status}
      </Badge>
      {#if subscription.provider}
        <span class="text-xs text-dark-2">via {subscription.provider}</span>
      {/if}
    </div>
    <dl class="mt-2 space-y-0.5 text-sm text-dark-2">
      {#if subscription.unitAmount != null}
        <div>
          Price: {(subscription.unitAmount / 100).toFixed(2)}
          {(subscription.currency ?? '').toUpperCase()}{#if subscription.interval}
            / {subscription.interval}{/if}
        </div>
      {/if}
      <div>Renews / ends: {dateTime(subscription.currentPeriodEnd)}</div>
      {#if subscription.cancelAtPeriodEnd}
        <div class="text-amber-300">Set to cancel at period end</div>
      {/if}
      {#if subscription.canceledAt}
        <div>Cancelled: {dateTime(subscription.canceledAt)}</div>
      {/if}
    </dl>
  {/if}

  <!-- Retool's Paddle wizard: find the account holding a customer id, unlink it, link this one. The
       page could already READ this column and deep-link to Paddle; nothing could correct it, and
       Paddle's webhooks resolve the account by exactly this value — so a mis-link sends one account's
       subscription events to another. -->
  <div class="mt-4 border-t border-dark-4 pt-3">
    <div class="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span class="text-xs tracking-wide text-dark-2 uppercase">Paddle customer</span>
      {#if paddleCustomerId}
        <a
          href="https://vendors.paddle.com/customers-v2/{paddleCustomerId}"
          target="_blank"
          rel="noreferrer"
          class={LINK_CLASS}
        >
          {paddleCustomerId}
        </a>
      {:else}
        <span class="text-dark-2">not linked</span>
      {/if}
      {#if canAct && !linking}
        <Button size="xs" variant="outline" onclick={() => (linking = true)}>
          {paddleCustomerId ? 'Re-link' : 'Link'}
        </Button>
      {/if}
    </div>

    {#if canAct && linking}
      {#if form.error}
        <p class="mt-2 text-sm text-red-300" role="alert">{form.error}</p>
      {/if}
      <form method="POST" action="?/linkPaddle" use:enhance={form.enhance} class="mt-2 grid gap-2">
        <input type="hidden" name="userId" value={userId} />
        <Input
          name="paddleCustomerId"
          value={conflict?.paddleCustomerId ?? ''}
          placeholder="Paddle customer id (ctm_…)"
          class="max-w-sm"
        />
        {#if conflict}
          <!-- Retool made unlinking a separate step. Kept as an explicit second submit rather than an
               automatic move: taking a customer id off another account is the destructive half. -->
          <p class="text-sm text-amber-200">
            <a href="/retool/user-lookup/basic?q={conflict.id}" class={LINK_CLASS}>
              {conflict.username ?? `#${conflict.id}`}
            </a>
            already holds that customer id.
          </p>
          <input type="hidden" name="takeFrom" value={conflict.id} />
        {/if}
        <div class="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={form.submitting}>
            {conflict ? 'Unlink there and link here' : 'Link'}
          </Button>
          {#if paddleCustomerId}
            <Button
              type="submit"
              name="unlink"
              value="1"
              size="sm"
              variant="destructive"
              disabled={form.submitting}
            >
              Unlink
            </Button>
          {/if}
          <Button type="button" size="sm" variant="outline" onclick={() => (linking = false)}>
            Cancel
          </Button>
        </div>
      </form>
    {/if}
  </div>
</section>
