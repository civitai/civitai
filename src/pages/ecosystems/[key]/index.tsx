import { Alert, Badge, Button, Card, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconBolt, IconDownload } from '@tabler/icons-react';
import clsx from 'clsx';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { NextLink } from '~/components/NextLink/NextLink';
import { useDomainColor } from '~/hooks/useDomainColor';
import { env } from '~/env/client';
import {
  getEcosystemOwnBaseModels,
  getEcosystemSeoData,
  type EcosystemSeoData,
} from '~/server/services/ecosystem-seo.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { generationGraphPanel } from '~/store/generation-graph.store';
import {
  ECOSYSTEM_SEO_PAGES,
  getConfigEcosystemKeys,
  getEcosystemSeoConfigBySlug,
  getEcosystemSeoSlug,
  isEcosystemSeoPageLive,
  isEcosystemSunset,
  LORA_COUNT_TOKEN,
  type EcosystemSeoConfig,
} from '~/shared/constants/ecosystem-seo.constants';
import { MediaType } from '~/shared/utils/prisma/enums';
import styles from './EcosystemPage.module.scss';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ ctx, session }) => {
    const slug = String(ctx.params?.key ?? '');
    const config = getEcosystemSeoConfigBySlug(slug);
    // Any URL/ecosystem mismatch (unknown slug, or a config with no resolvable data) lands
    // the user on the ecosystems index rather than a dead 404.
    const toIndex = { redirect: { destination: '/ecosystems', permanent: false } } as const;
    if (!config) return toIndex;
    // ?refresh=true busts the 24h cache — moderators only, so it can't be a public stampede vector.
    const refresh = ctx.query.refresh === 'true' && !!session?.user?.isModerator;
    const data = await getEcosystemSeoData(config.key, { refresh });
    if (!data) return toIndex;
    // Base models for the "Browse models" deep-link — seeds the /models `baseModels` filter.
    // Scoped to the page's own declared ecosystems, matching the stat counts (no family bleed).
    const browseBaseModels = [
      ...new Set(getConfigEcosystemKeys(config).flatMap((key) => getEcosystemOwnBaseModels(key))),
    ];
    // Strip the moderator-only fact-check flags from the config sent to the client (the review
    // sidebar reads them itself, gated to moderators).
    const { factCheck: _factCheck, ...clientConfig } = config;
    // Evaluated server-side so the banner and noindex don't flip between render and hydration.
    const sunset = isEcosystemSunset(config);
    return { props: { config: clientConfig, data, browseBaseModels, sunset } };
  },
});

function formatCount(n: number): string {
  // 2 decimals in the 1–10B band (0.1B hides 100M, so keep the granularity); 0 above.
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 0 : 2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return `${n}`;
}

const formatSunsetDate = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

const generateUrl = (versionId: number) => `/generate?modelVersionId=${versionId}`;
const modelUrl = (modelId: number, versionId: number) =>
  `/models/${modelId}?modelVersionId=${versionId}`;

export default function EcosystemPage({
  config,
  data,
  browseBaseModels,
  sunset,
}: {
  config: EcosystemSeoConfig;
  data: EcosystemSeoData;
  browseBaseModels: string[];
  sunset: boolean;
}) {
  const { name } = config;
  // Index these pages on civitai.com (green) only; noindex on red/blue — and never once the
  // ecosystem's endpoints are gone.
  const deIndex = useDomainColor() !== 'green' || sunset;
  const mediaType = config.modality === 'video' ? 'video' : 'image';
  const isVideo = mediaType === 'video';
  // Dual-modality (e.g. Grok does image + video): neutral labels, and the example gallery
  // renders each item as its own type. The generation stat counts both already.
  const isDual = !!config.secondaryModality;
  const genNoun = isDual ? 'Images & videos' : isVideo ? 'Videos' : 'Images';
  // Simplified template: engine/API-only ecosystems (Kling, Seedance, …) have no community
  // LoRAs and no local weights. Drop the LoRA section/stat/nav and swap the "run locally"
  // card for an API-only note.
  const hasLoras = data.topLoras.length > 0;
  const apiOnly = !config.localRun;
  const slug = getEcosystemSeoSlug(config);
  const baseUrl = env.NEXT_PUBLIC_BASE_URL ?? 'https://civitai.com';
  const browseHref = browseBaseModels.length
    ? `/models?${browseBaseModels.map((b) => `baseModels=${encodeURIComponent(b)}`).join('&')}`
    : '/models';

  // `{loras:Key}` in a comparison cell → that ecosystem's live LoRA count, formatted like the
  // hero stat. An unresolved key renders as an em dash rather than leaking the raw token.
  const resolveComparisonValue = (value: string) =>
    value.replace(LORA_COUNT_TOKEN, (_, key: string) => {
      const count = data.loraCounts[key];
      return count ? `${formatCount(count)}+` : '—';
    });

  // A row of live counts can't carry a hand-set winner — highlight whichever column actually
  // has the most. Rows without tokens keep their curated `winner`.
  const comparisonWinner = (row: EcosystemSeoConfig['comparison']['rows'][number]) => {
    const counts = row.values.map((value) => {
      const match = [...value.matchAll(LORA_COUNT_TOKEN)][0];
      return match ? data.loraCounts[match[1]] ?? 0 : -1;
    });
    const best = Math.max(...counts);
    return best > 0 ? counts.indexOf(best) : row.winner;
  };

  // OG/social card: the first curated (SFW) featured cover, else an example. Meta builds a
  // 1200-wide edge URL and handles video posters; falls back to the site default if absent.
  const ogImageUrl = data.featuredModels[0]?.imageUrl ?? data.featuredExamples[0]?.url;
  const ogImage = ogImageUrl
    ? { url: ogImageUrl, nsfwLevel: 1, type: isVideo ? MediaType.video : MediaType.image }
    : undefined;

  const schema = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: baseUrl },
          { '@type': 'ListItem', position: 2, name: 'Ecosystems', item: `${baseUrl}/ecosystems` },
          { '@type': 'ListItem', position: 3, name, item: `${baseUrl}/ecosystems/${slug}` },
        ],
      },
      {
        '@type': 'FAQPage',
        mainEntity: config.faq.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
    ],
  };

  return (
    <>
      <Meta
        title={`${name} AI Models & Generator | Civitai`}
        description={config.metaDescription}
        canonical={`/ecosystems/${slug}`}
        images={ogImage}
        schema={schema}
        deIndex={deIndex}
      />

      <div className={styles.page}>
        {/* Hero */}
        <section className={styles.hero}>
          <div className={styles.container}>
            <nav className={styles.breadcrumb}>
              <NextLink href="/">Home</NextLink> /{' '}
              <NextLink href="/ecosystems">Ecosystems</NextLink> / <span>{name}</span>
            </nav>

            <h1 className={styles.heroTitle}>
              {name}
              {config.isNew && <span className={clsx(styles.newBadge, 'ml-3')}>New</span>}
            </h1>

            <div className={styles.badgeRow}>
              {config.hero.badges.map((b) => (
                <span key={b} className={styles.badge}>
                  {b}
                </span>
              ))}
            </div>

            {config.sunset && (
              <Alert
                color={sunset ? 'red' : 'yellow'}
                icon={<IconAlertTriangle size={18} />}
                my="md"
              >
                <strong>
                  {sunset
                    ? `${name} has been retired.`
                    : `${name} is being retired on ${formatSunsetDate(config.sunset.date)}.`}
                </strong>{' '}
                {config.sunset.note}
              </Alert>
            )}

            <p className={styles.heroIntro}>{config.hero.intro}</p>

            <div className={styles.ctaRow}>
              <Button
                component={NextLink}
                href={generateUrl(config.generatorVersionId)}
                color="yellow"
                size="md"
                leftSection={<IconBolt size={18} />}
              >
                Generate with {name}
              </Button>
              <Button component={NextLink} href={browseHref} variant="default" size="md">
                Browse {name} models
              </Button>
            </div>

            <div className={styles.statsRow}>
              <Stat label={`${name} models`} value={`${formatCount(data.stats.modelCount)}+`} />
              <Stat
                label={`${genNoun} generated`}
                value={`${formatCount(data.stats.generationCount)}+`}
              />
              {hasLoras && (
                <Stat label={`${name} LoRAs`} value={`${formatCount(data.stats.loraCount)}+`} />
              )}
            </div>
          </div>
        </section>

        {/* Quick nav */}
        <nav className={styles.quickNav} aria-label="On this page">
          <div className={clsx(styles.container, 'flex w-full gap-3 !px-6')}>
            {config.overview && (
              <NextLink href="#overview" className={styles.navChip}>
                Overview
              </NextLink>
            )}
            <NextLink href="#best-models" className={styles.navChip}>
              Best Models
            </NextLink>
            {hasLoras && (
              <NextLink href="#loras" className={styles.navChip}>
                LoRAs
              </NextLink>
            )}
            <NextLink href="#examples" className={styles.navChip}>
              Examples
            </NextLink>
            <NextLink href="#how-to-run" className={styles.navChip}>
              How to Run
            </NextLink>
            <NextLink href="#compare" className={styles.navChip}>
              {name} vs Others
            </NextLink>
            <NextLink href="#faq" className={styles.navChip}>
              FAQ
            </NextLink>
          </div>
        </nav>

        {/* Overview — unique long-form prose (SEO depth + de-duplication) */}
        {config.overview && (
          <section className={styles.section} id="overview">
            <div className={styles.container}>
              <SectionHeader title={`About ${name}`} />
              <div className={styles.overviewProse}>
                {config.overview.map((para, i) => (
                  <p key={i}>{para}</p>
                ))}
              </div>
              {config.promptTips && config.promptTips.length > 0 && (
                <div className={styles.promptTips}>
                  <h3>How to prompt {name}</h3>
                  <ul>
                    {config.promptTips.map((tip, i) => (
                      <li key={i}>{tip}</li>
                    ))}
                  </ul>
                </div>
              )}
              {(isVideo || apiOnly) && (
                <p className={styles.freshnessNote}>
                  AI models move fast — new versions ship often, and a model’s capabilities or Buzz
                  cost can change. For the latest, check the model’s own page before you generate.
                </p>
              )}
            </div>
          </section>
        )}

        {/* Featured models */}
        <section className={styles.section} id="best-models">
          <div className={styles.container}>
            <SectionHeader
              title={`Featured ${name} models`}
              subtitle="Curated — the models worth generating with first."
            />
            <SimpleGrid cols={{ base: 2, sm: 3, md: 6 }}>
              {data.featuredModels.map((m) => (
                <ResourceCard
                  key={m.versionId}
                  modelId={m.modelId}
                  versionId={m.versionId}
                  name={m.name}
                  type={m.type}
                  imageUrl={m.imageUrl}
                  note={m.note}
                  downloadCount={m.downloadCount}
                  generationCount={m.generationCount}
                  mediaType={mediaType}
                  generatable={m.generatable}
                  alt={`${m.name} — ${name} ${m.type.toLowerCase()} preview`}
                />
              ))}
            </SimpleGrid>
          </div>
        </section>

        {/* Top LoRAs — omitted for engine/API-only ecosystems that have none */}
        {hasLoras && (
          <section className={styles.section} id="loras">
            <div className={styles.container}>
              <SectionHeader
                title={`Popular ${name} LoRAs & add-ons`}
                subtitle="Top LoRAs by downloads — live data, refreshed daily. Stack them on any checkpoint."
              />
              <SimpleGrid cols={{ base: 2, sm: 3, md: 6 }}>
                {data.topLoras.map((l) => (
                  <ResourceCard
                    key={l.versionId}
                    modelId={l.modelId}
                    versionId={l.versionId}
                    name={l.name}
                    type="LORA"
                    imageUrl={l.imageUrl}
                    downloadCount={l.downloadCount}
                    generationCount={l.generationCount}
                    mediaType={l.imageType ?? mediaType}
                    alt={`${l.name} — ${name} LoRA preview`}
                  />
                ))}
              </SimpleGrid>
            </div>
          </section>
        )}

        {/* Example generations */}
        <section className={styles.section} id="examples">
          <div className={styles.container}>
            <SectionHeader
              title={
                isDual ? 'Example generations' : isVideo ? 'Example videos' : 'Example generations'
              }
              subtitle={`Curated, safe-for-work showcase — every ${
                isDual ? 'image and clip' : isVideo ? 'clip' : 'image'
              } ships with its prompt and settings.`}
            />
            <div className={styles.galleryGrid}>
              {data.featuredExamples.map((ex) => (
                <div key={ex.imageId} className={styles.galleryCard}>
                  <div className={styles.galleryImage}>
                    <EdgeMedia
                      src={ex.url}
                      type={ex.type}
                      width={450}
                      fit="cover"
                      className={styles.mediaFill}
                      anim={ex.type === 'video'}
                      alt={`${name} example ${ex.type}${
                        ex.prompt ? `: ${ex.prompt.replace(/\s+/g, ' ').slice(0, 120)}` : ''
                      }`}
                    />
                  </div>
                  <div className={styles.galleryInfo}>
                    <div className={styles.galleryPrompt}>{ex.prompt}</div>
                    <div className={styles.gallerySettings}>{ex.settings}</div>
                    <Button
                      onClick={() => generationGraphPanel.open({ type: ex.type, id: ex.imageId })}
                      color="blue"
                      fullWidth
                      size="xs"
                      className={styles.remixButton}
                    >
                      Remix this →
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* How to run */}
        <section className={styles.section} id="how-to-run">
          <div className={styles.container}>
            <SectionHeader
              title={`How to run ${name}`}
              subtitle={
                apiOnly
                  ? `${name} is a hosted API model — skip the setup and generate on Civitai.`
                  : 'Two paths — one takes ten seconds, one takes an afternoon.'
              }
            />
            <div className={styles.twoCol}>
              <div className={clsx(styles.colCard, styles.recommended)}>
                <h3>⚡ Run on Civitai (Recommended)</h3>
                <p>
                  <strong>The fastest way to start.</strong>
                </p>
                <div className={styles.check}>No GPU required</div>
                <div className={styles.check}>In-browser generation in seconds</div>
                <div className={styles.check}>One click from any model on this page</div>
                <div className={styles.check}>Works on mobile</div>
                <Button
                  component={NextLink}
                  href={generateUrl(config.generatorVersionId)}
                  color="yellow"
                  fullWidth
                  mt="md"
                  leftSection={<IconBolt size={18} />}
                >
                  Generate now
                </Button>
                <div className={styles.membersCallout}>
                  <strong>Level up:</strong> Members get more daily generations and priority queue
                  on {name}. <NextLink href="/pricing">See membership →</NextLink>
                </div>
              </div>

              <div className={styles.colCard}>
                <h3>{apiOnly ? '🔌 API-only model' : '🖥️ Run it locally'}</h3>
                {config.localRun ? (
                  <>
                    <p>
                      <strong>For power users who want full control.</strong>
                    </p>
                    <div className={styles.check}>Full control over the workflow</div>
                    <div className={styles.check}>Batch and automate</div>
                    <div className={styles.caveat}>Needs a {config.localRun.vram} GPU</div>
                    <div className={styles.caveat}>
                      Download {config.localRun.weightsSize} of weights
                    </div>
                    <div className={styles.caveat}>Set up {config.localRun.tool} yourself</div>
                    <p style={{ marginTop: 16, fontSize: 12, color: 'var(--text-muted)' }}>
                      No graphics card? The Civitai path above skips all of this.
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      <strong>{name}</strong> runs through its provider&apos;s API — there are no
                      public weights to download and nothing to install.
                    </p>
                    <div className={styles.check}>Always the latest hosted version</div>
                    <div className={styles.check}>No GPU, no setup</div>
                    <div className={styles.caveat}>No offline / local option</div>
                    <p style={{ marginTop: 16, fontSize: 12, color: 'var(--text-muted)' }}>
                      Civitai handles the API access — you just prompt and generate.
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Comparison */}
        <section className={styles.section} id="compare">
          <div className={styles.container}>
            <SectionHeader
              title={`${name} vs other ecosystems`}
              subtitle="Backed by Civitai usage data."
            />
            <div className={styles.tableWrap}>
              <table className={styles.comparisonTable}>
                <thead>
                  <tr>
                    <th>Feature</th>
                    <th className={styles.colFluxHead}>{name}</th>
                    {config.comparison.peers.map((p) => (
                      <th key={p}>{p}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {config.comparison.rows.map((row) => {
                    const winner = comparisonWinner(row);
                    return (
                      <tr key={row.label}>
                        <td className={styles.rowHeader}>{row.label}</td>
                        {row.values.map((v, i) => {
                          const value = resolveComparisonValue(v);
                          return (
                            <td key={i} className={i === 0 ? styles.colFlux : undefined}>
                              {winner === i ? (
                                <span className={styles.comparisonCheck}>{value}</span>
                              ) : (
                                value
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className={styles.section} id="faq">
          <div className={styles.container}>
            <SectionHeader title="Frequently asked questions" />
            <div className={styles.faqList}>
              {config.faq.map((f, i) => (
                <div key={i} className={styles.faqItem}>
                  <h3 className={styles.faqQuestion}>{f.q}</h3>
                  <div className={styles.faqAnswer}>{f.a}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA band */}
        <div className={styles.container}>
          <div className={styles.ctaBand}>
            <h2>Start generating with {name} now</h2>
            <p>No installation. No GPU. Runs in your browser.</p>
            <div className={styles.ctaBandButtons}>
              <Button
                component={NextLink}
                href={generateUrl(config.generatorVersionId)}
                color="yellow"
                size="md"
                leftSection={<IconBolt size={18} />}
              >
                Generate with {name}
              </Button>
              <Button component={NextLink} href={browseHref} variant="default" size="md">
                Browse models
              </Button>
            </div>
            <div className={styles.membershipNote}>
              Want more daily generations and a faster queue?{' '}
              <NextLink href="/pricing">Explore Civitai membership.</NextLink>
            </div>
          </div>
        </div>

        {/* Footer cross-links */}
        <footer className={styles.footer}>
          <div className={styles.container}>
            <div className={styles.footerText}>Explore other generation ecosystems on Civitai</div>
            <div className={styles.ecosystemLinks}>
              {ECOSYSTEM_SEO_PAGES.filter((page) => page.slug !== slug).map((page) =>
                isEcosystemSeoPageLive(page.slug) ? (
                  <NextLink
                    key={page.slug}
                    href={`/ecosystems/${page.slug}`}
                    className={styles.ecosystemLink}
                  >
                    {page.label}
                  </NextLink>
                ) : (
                  <span key={page.slug} className={styles.ecosystemLink}>
                    {page.label}
                  </span>
                )
              )}
            </div>
            <div className={styles.footerText} style={{ marginTop: 24 }}>
              {name} is {config.attribution}.
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.statItem}>
      <span className={styles.statNumber}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className={styles.sectionHeader}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {subtitle && <p className={styles.sectionSubtitle}>{subtitle}</p>}
    </div>
  );
}

function ResourceCard({
  modelId,
  versionId,
  name,
  type,
  imageUrl,
  note,
  mediaType,
  alt,
  downloadCount = 0,
  generationCount = 0,
  generatable = true,
}: {
  modelId: number;
  versionId: number;
  name: string;
  type: string;
  imageUrl?: string;
  note?: string;
  mediaType: 'image' | 'video';
  alt: string;
  downloadCount?: number;
  generationCount?: number;
  /** False for a checkpoint that isn't always hosted — the card links out instead of generating. */
  generatable?: boolean;
}) {
  return (
    <Card withBorder padding="sm" radius="md" className="flex h-full flex-col">
      {imageUrl && (
        <Card.Section component={NextLink} href={modelUrl(modelId, versionId)}>
          <EdgeMedia
            src={imageUrl}
            type={mediaType}
            width={450}
            fit="cover"
            className="aspect-square w-full object-cover"
            anim={mediaType === 'video'}
            alt={alt}
          />
        </Card.Section>
      )}
      <Stack gap={6} mt={imageUrl ? 'sm' : 0} className="grow">
        <Badge size="xs" variant="light" color={type === 'Checkpoint' ? 'green' : 'violet'}>
          {type}
        </Badge>
        <Text
          component={NextLink}
          href={modelUrl(modelId, versionId)}
          fw={600}
          lineClamp={2}
          c="inherit"
          className="hover:underline"
        >
          {name}
        </Text>
        {(downloadCount > 0 || generationCount > 0) && (
          <Group gap="sm" wrap="nowrap">
            {downloadCount > 0 && (
              <Text size="xs" c="dimmed" className="flex items-center gap-1" title="Downloads">
                <IconDownload size={12} />
                {formatCount(downloadCount)}
              </Text>
            )}
            {generationCount > 0 && (
              <Text size="xs" c="dimmed" className="flex items-center gap-1" title="Generations">
                <IconBolt size={12} />
                {formatCount(generationCount)}
              </Text>
            )}
          </Group>
        )}
        {note && (
          <Text size="xs" c="dimmed">
            {note}
          </Text>
        )}
      </Stack>
      {generatable ? (
        <Button
          onClick={() => generationGraphPanel.open({ type: 'modelVersion', id: versionId })}
          color="yellow"
          size="xs"
          fullWidth
          mt="sm"
          leftSection={<IconBolt size={14} />}
        >
          Generate
        </Button>
      ) : (
        <Button
          component={NextLink}
          href={modelUrl(modelId, versionId)}
          variant="default"
          size="xs"
          fullWidth
          mt="sm"
        >
          View model
        </Button>
      )}
    </Card>
  );
}
