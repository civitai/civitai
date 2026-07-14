<script lang="ts">
  import { Card, CardHeader, CardTitle, CardContent } from '@civitai/ui/components/ui/card/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import {
    CREATOR_PROGRAM_URL,
    CIVITAI_MEMBERSHIP_URL,
    CIVITAI_MANAGE_MEMBERSHIP_URL,
  } from '$lib/creator-program';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const BUZZ_DASHBOARD_URL = 'https://civitai.com/user/buzz-dashboard';
  // Payout onboarding is gated on settled cash so we don't push creators into a Tipalti signup (which bills
  // us per account) before they can actually withdraw. TODO: unlock the button once the settled-cash read is
  // wired — until then "not set up" always shows the locked message.
  const PAYOUT_UNLOCK_USD = 50;

  const tier = $derived(data.membership.tier);
  const isMember = $derived(data.membership.isMember);
  const isCP = $derived(data.membership.isCreatorProgramMember);
</script>

<header class="page-header">
  <h1>Settings</h1>
  <p>Your membership, payouts, and fee defaults.</p>
</header>

<div class="flex flex-col gap-5">
  <Card>
    <CardHeader class="flex flex-row items-center gap-3">
      <CardTitle class="text-base text-white">Membership</CardTitle>
      {#if isCP}
        <Badge variant="default" class="ml-auto">Creator Program</Badge>
      {:else if isMember}
        <Badge variant="secondary" class="ml-auto">Member</Badge>
      {:else}
        <Badge variant="outline" class="ml-auto">Not a member</Badge>
      {/if}
    </CardHeader>
    <CardContent class="flex flex-col gap-3">
      <p class="text-sm text-dark-0">
        {#if isCP}
          You're a Creator Program member{tier ? ` on the ${tier} tier` : ''} —
          <strong class="text-green-5">monetization is unlocked</strong>.
        {:else if isMember}
          You have an active {tier} membership.
          <strong class="text-white">Join the Creator Program to unlock monetization.</strong>
        {:else}
          You don't have an active Civitai membership.
        {/if}
      </p>
      <div class="flex flex-wrap gap-2">
        {#if isMember || isCP}
          <Button
            href={CIVITAI_MANAGE_MEMBERSHIP_URL}
            target="_blank"
            rel="noopener noreferrer"
            variant="secondary"
            size="sm"
          >
            Manage membership
          </Button>
        {:else}
          <Button href={CIVITAI_MEMBERSHIP_URL} variant="secondary" size="sm">Get a membership</Button>
        {/if}
        {#if !isCP}
          <Button href={CREATOR_PROGRAM_URL} variant="secondary" size="sm">Creator Program</Button>
        {/if}
      </div>
    </CardContent>
  </Card>

  <Card>
    <CardHeader class="flex flex-row items-center gap-3">
      <CardTitle class="text-base text-white">Payouts</CardTitle>
      {#if data.payout === 'active'}
        <Badge variant="default" class="ml-auto">Active</Badge>
      {:else if data.payout === 'pending'}
        <Badge variant="secondary" class="ml-auto">Pending setup</Badge>
      {:else}
        <Badge variant="outline" class="ml-auto">Locked</Badge>
      {/if}
    </CardHeader>
    <CardContent class="flex flex-col gap-3">
      <p class="text-sm text-dark-0">
        {#if data.payout === 'active'}
          Your Tipalti payout account is active. Manage it and withdraw earnings on the Buzz dashboard.
        {:else if data.payout === 'pending'}
          Your payout onboarding is started but not finished — complete it to withdraw earnings as cash.
        {:else}
          Payout setup unlocks once you have <strong class="text-white">${PAYOUT_UNLOCK_USD} in settled cash</strong>
          ready to withdraw — so there's nothing to set up yet.
        {/if}
      </p>
      {#if data.payout !== 'not_set_up'}
        <div>
          <Button
            href={BUZZ_DASHBOARD_URL}
            target="_blank"
            rel="noopener noreferrer"
            variant="secondary"
            size="sm"
          >
            {data.payout === 'active' ? 'Manage payouts' : 'Continue payout setup'}
          </Button>
        </div>
      {/if}
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base text-white">Fee defaults</CardTitle>
    </CardHeader>
    <CardContent>
      <p class="text-sm text-dark-2">
        Licensing fees stay off until you set one. When you do, the input is seeded with a suggested default by
        model type — Checkpoints <strong>1</strong> ⚡ / image, LoRAs <strong>0.1</strong> ⚡ / image — which you
        can override per version on <a href="/models" class="underline">Models</a>.
      </p>
    </CardContent>
  </Card>
</div>
