<script lang="ts">
  import { Card, CardHeader, CardTitle, CardContent } from '@civitai/ui/components/ui/card/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';

  // CTA target + copy depend on the tier-vs-CP gate decision (B1) — kept as a single link so it's easy to flip.
  const SUBSCRIBE_URL = 'https://civitai.com/pricing';

  const perks = [
    { title: 'Set licensing fees', body: 'Charge a per-image fee when others generate with your models.' },
    { title: 'Sell access indefinitely', body: 'Offer your versions for sale with no time or quantity cap.' },
    { title: 'Earnings & analytics', body: 'See what your models earn and what usage drives it.' },
  ];
</script>

<header class="page-header">
  <h1>Become a member</h1>
  <p>Unlock the tools to earn from your models.</p>
</header>

<section class="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
  {#each perks as perk (perk.title)}
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

<Button href={SUBSCRIBE_URL}>View membership plans</Button>
