<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { buildWordmarkSvg } from '@civitai/brand';
  import {
    IconLicense,
    IconChartBar,
    IconCoin,
    IconArrowRight,
    IconBolt,
  } from '@tabler/icons-svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const wordmark = buildWordmarkSvg({ base: '#e8eaed' });
  const canonical = $derived(`${data.origin}/`);

  const TITLE = 'Civitai Creator Studio — Monetize your AI models';
  const DESCRIPTION =
    'Earn from the AI models you share on Civitai. Set per-generation licensing fees, track real usage analytics, and get paid in cash through the Creator Program.';

  const features = [
    {
      icon: IconLicense,
      title: 'Licensing fees',
      body: 'Put a per-generation fee on your models and earn every time the community creates with them — priced by you, in Buzz.',
    },
    {
      icon: IconChartBar,
      title: 'Real usage analytics',
      body: 'Generations, downloads, reactions, and earnings broken down per model and base model — the numbers that actually drive your fees.',
    },
    {
      icon: IconCoin,
      title: 'Creator Program payouts',
      body: 'Bank the Buzz you earn and convert it to real cash through the Civitai Creator Program, with a clear history of every payout.',
    },
  ];

  const jsonLd = $derived(
    JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: 'Civitai Creator Studio',
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      url: canonical,
      description: DESCRIPTION,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      publisher: { '@type': 'Organization', name: 'Civitai', url: 'https://civitai.com' },
    })
  );
</script>

<svelte:head>
  <title>{TITLE}</title>
  <meta name="description" content={DESCRIPTION} />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href={canonical} />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Civitai Creator Studio" />
  <meta property="og:title" content={TITLE} />
  <meta property="og:description" content={DESCRIPTION} />
  <meta property="og:url" content={canonical} />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content={TITLE} />
  <meta name="twitter:description" content={DESCRIPTION} />
  {@html `<script type="application/ld+json">${jsonLd}</` + `script>`}
</svelte:head>

<!-- Links into the gated (app) go through the auth guard (a hook-level redirect the SPA router won't follow),
     so force full-page navigation on this page's internal links. -->
<div class="min-h-screen bg-background text-foreground" data-sveltekit-reload>
  <header class="mx-auto flex w-full max-w-6xl items-center gap-3 px-6 py-5">
    <div class="flex items-center gap-2 [&>span>svg]:block [&>span>svg]:h-6 [&>span>svg]:w-auto">
      <span>{@html wordmark}</span>
      <span
        class="rounded bg-dark-6 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-dark-1"
      >
        studio
      </span>
    </div>
    <div class="ml-auto">
      <Button href="/dashboard" variant="ghost" size="sm" class="text-foreground">Sign in</Button>
    </div>
  </header>

  <main>
    <section class="mx-auto w-full max-w-6xl px-6 pb-16 pt-12 sm:pt-20">
      <div class="max-w-2xl">
        <span
          class="inline-flex items-center gap-1.5 rounded-full border border-blue-8/40 bg-blue-9/10 px-3 py-1 text-xs font-medium text-blue-3"
        >
          <IconBolt size={13} /> For Civitai creators
        </span>
        <h1 class="mt-5 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
          Get paid for the models you share.
        </h1>
        <p class="mt-5 text-lg text-dark-1">
          Creator Studio is where Civitai creators set licensing fees, watch real usage, and turn the
          Buzz they earn into cash — all in one place.
        </p>
        <div class="mt-8 flex flex-wrap items-center gap-3">
          <Button href="/dashboard" size="lg" class="gap-1.5">
            Open Creator Studio <IconArrowRight size={18} />
          </Button>
          <Button
            href="https://civitai.com"
            target="_blank"
            rel="noreferrer"
            variant="outline"
            size="lg"
            class="text-foreground"
          >
            Explore Civitai
          </Button>
        </div>
      </div>
    </section>

    <section class="border-t border-dark-5 bg-dark-8/40">
      <div class="mx-auto grid w-full max-w-6xl gap-6 px-6 py-16 sm:grid-cols-3">
        {#each features as f (f.title)}
          {@const Icon = f.icon}
          <div class="rounded-xl bg-card p-6 ring-1 ring-foreground/10">
            <div
              class="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-9/20 text-blue-3"
            >
              <Icon size={20} />
            </div>
            <h2 class="mt-4 text-lg font-semibold text-white">{f.title}</h2>
            <p class="mt-2 text-sm text-dark-1">{f.body}</p>
          </div>
        {/each}
      </div>
    </section>

    <section class="mx-auto w-full max-w-6xl px-6 py-16">
      <div
        class="flex flex-col items-start gap-5 rounded-2xl border border-blue-8/30 bg-blue-9/10 p-8 sm:flex-row sm:items-center"
      >
        <div>
          <h2 class="text-2xl font-semibold text-white">Ready to start earning?</h2>
          <p class="mt-2 text-dark-1">
            Sign in with your Civitai account to set your first licensing fee and join the Creator
            Program.
          </p>
        </div>
        <Button href="/dashboard" size="lg" class="shrink-0 gap-1.5 sm:ml-auto">
          Open Creator Studio <IconArrowRight size={18} />
        </Button>
      </div>
    </section>
  </main>

  <footer class="border-t border-dark-5">
    <div
      class="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-6 py-6 text-xs text-dark-3"
    >
      <span>© Civitai</span>
      <a href="https://civitai.com" target="_blank" rel="noreferrer" class="hover:text-white">
        civitai.com
      </a>
      <a href="/dashboard" class="ml-auto hover:text-white">Sign in →</a>
    </div>
  </footer>
</div>
