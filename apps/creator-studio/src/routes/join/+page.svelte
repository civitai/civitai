<script lang="ts">
  import { Card, CardHeader, CardTitle, CardContent } from '@civitai/ui/components/ui/card/index.js';
  import { IconCheck, IconX, IconTrendingUp } from '@tabler/icons-svelte';
  import {
    CREATOR_PROGRAM_URL,
    CIVITAI_MEMBERSHIP_URL,
    MIN_CREATOR_SCORE,
    CREATOR_PROGRAM_PERKS,
    CREATOR_PROGRAM_CAPABILITIES,
    CREATOR_SCORE_TIPS,
  } from '$lib/creator-program';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const scoreLabel = MIN_CREATOR_SCORE.toLocaleString();
  // A paying member only needs to clear the creator-score bar; a non-member needs a membership first.
  const isMember = $derived(data.membership.isMember);
  const score = $derived(Math.round(data.creatorScore));
  const qualifiesScore = $derived(score >= MIN_CREATOR_SCORE);
  const scorePct = $derived(Math.min(100, Math.round((score / MIN_CREATOR_SCORE) * 100)));
</script>

<header class="page-header">
  <h1>Join the Creator Program</h1>
  <p>Unlock the Studio's monetization tools — set licensing fees and sell access to your models.</p>
</header>

<section class="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
  {#each CREATOR_PROGRAM_PERKS as perk (perk.title)}
    <Card class="h-full">
      <CardHeader>
        <CardTitle class="text-base text-white">{perk.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p class="text-sm text-dark-2">{perk.body}</p>
      </CardContent>
    </Card>
  {/each}
</section>

<Card class="mb-8">
  <CardHeader>
    <CardTitle class="text-base text-white">What membership unlocks</CardTitle>
  </CardHeader>
  <CardContent>
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-dark-4 text-left text-xs uppercase tracking-wide text-dark-3">
            <th class="py-2 pr-4 font-medium">Capability</th>
            <th class="w-24 py-2 text-center font-medium">Everyone</th>
            <th class="w-32 py-2 text-center font-medium">Creator Program</th>
          </tr>
        </thead>
        <tbody>
          {#each CREATOR_PROGRAM_CAPABILITIES as row (row.label)}
            <tr class="border-b border-dark-6">
              <td class="py-2 pr-4 text-dark-1">{row.label}</td>
              <td class="py-2 text-center">
                {#if row.everyone}
                  <IconCheck size={16} class="mx-auto text-green-5" />
                {:else}
                  <IconX size={16} class="mx-auto text-dark-4" />
                {/if}
              </td>
              <td class="py-2 text-center">
                {#if row.member}
                  <IconCheck size={16} class="mx-auto text-green-5" />
                {:else}
                  <IconX size={16} class="mx-auto text-dark-4" />
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </CardContent>
</Card>

<div class="mb-6 rounded-lg border border-dark-4 bg-dark-6 p-4">
  <div class="flex items-center justify-between text-sm">
    <span class="text-dark-1">Your creator score</span>
    <span class="font-medium text-white">
      {score.toLocaleString()} <span class="text-dark-3">/ {scoreLabel}</span>
    </span>
  </div>
  <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-dark-7">
    <div
      class="h-full rounded-full {qualifiesScore ? 'bg-green-5' : 'bg-blue-8'}"
      style="width: {scorePct}%"
    ></div>
  </div>
  <p class="mt-3 text-sm text-dark-2">
    {#if isMember && qualifiesScore}
      You meet both requirements —
      <a href={CREATOR_PROGRAM_URL} class="underline">join the Creator Program</a> to unlock monetization.
    {:else if isMember}
      You have a Civitai membership; reach a creator score of <strong>{scoreLabel}</strong> to qualify.
    {:else if qualifiesScore}
      Your score qualifies — you'll also need an active
      <a href={CIVITAI_MEMBERSHIP_URL} class="underline">Civitai membership</a>.
    {:else}
      The Creator Program requires an active
      <a href={CIVITAI_MEMBERSHIP_URL} class="underline">Civitai membership</a> <strong>and</strong> a creator
      score of <strong>{scoreLabel}</strong>.
    {/if}
  </p>
</div>

{#if !qualifiesScore}
  <Card class="mb-8">
    <CardHeader>
      <CardTitle class="text-base text-white">How to grow your creator score</CardTitle>
    </CardHeader>
    <CardContent>
      <ul class="flex flex-col gap-4">
        {#each CREATOR_SCORE_TIPS as tip (tip.title)}
          <li class="flex gap-3">
            <IconTrendingUp size={18} class="mt-0.5 shrink-0 text-green-5" />
            <div>
              <p class="text-sm font-medium text-white">{tip.title}</p>
              <p class="text-sm text-dark-2">{tip.body}</p>
            </div>
          </li>
        {/each}
      </ul>
    </CardContent>
  </Card>
{/if}