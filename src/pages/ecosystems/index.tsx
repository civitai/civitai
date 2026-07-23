import { Meta } from '~/components/Meta/Meta';
import { NextLink } from '~/components/NextLink/NextLink';
import { useDomainColor } from '~/hooks/useDomainColor';
import { env } from '~/env/client';
import {
  getEcosystemSeoConfigBySlug,
  getLiveEcosystemSeoPages,
  type EcosystemSeoConfig,
} from '~/shared/constants/ecosystem-seo.constants';
import styles from './[key]/EcosystemPage.module.scss';

type IndexEntry = { slug: string; config: EcosystemSeoConfig };

const firstSentence = (text: string) => {
  const match = text.match(/^.*?[.!?](\s|$)/);
  return (match ? match[0] : text).trim();
};

export default function EcosystemsIndexPage() {
  // Index on civitai.com (green) only; noindex on red/blue.
  const deIndex = useDomainColor() !== 'green';
  const baseUrl = env.NEXT_PUBLIC_BASE_URL ?? 'https://civitai.com';
  const entries = getLiveEcosystemSeoPages().reduce<IndexEntry[]>((acc, page) => {
    const config = getEcosystemSeoConfigBySlug(page.slug);
    if (config) acc.push({ slug: page.slug, config });
    return acc;
  }, []);

  const imageEntries = entries.filter((e) => e.config.modality !== 'video');
  const videoEntries = entries.filter((e) => e.config.modality === 'video');

  const schema = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: baseUrl },
          { '@type': 'ListItem', position: 2, name: 'Ecosystems', item: `${baseUrl}/ecosystems` },
        ],
      },
      {
        '@type': 'CollectionPage',
        name: 'AI Image & Video Generation Model Ecosystems',
        url: `${baseUrl}/ecosystems`,
        hasPart: entries.map((e) => ({
          '@type': 'WebPage',
          name: e.config.name,
          url: `${baseUrl}/ecosystems/${e.slug}`,
        })),
      },
    ],
  };

  return (
    <>
      <Meta
        title="AI Image & Video Generation Models | Civitai"
        description="Explore every AI generation ecosystem on Civitai — Flux, Stable Diffusion, SDXL, Pony, Illustrious, Qwen, Wan, LTX Video and more. Compare models, see real generations, and start creating."
        canonical="/ecosystems"
        schema={schema}
        deIndex={deIndex}
      />

      <div className={styles.page}>
        <section className={styles.hero}>
          <div className={styles.container}>
            <nav className={styles.breadcrumb}>
              <NextLink href="/">Home</NextLink> / <span>Ecosystems</span>
            </nav>

            <h1 className={styles.heroTitle}>Generation Ecosystems</h1>
            <p className={styles.heroIntro}>
              Every major AI image and video model family, hosted and generatable on Civitai. Pick
              an ecosystem to see its best checkpoints and LoRAs, real example generations with
              their prompts, and how it compares — then start creating right here.
            </p>
          </div>
        </section>

        <EcosystemSection title="Image models" entries={imageEntries} />
        {videoEntries.length > 0 && (
          <EcosystemSection title="Video models" entries={videoEntries} />
        )}

        <footer className={styles.footer}>
          <div className={styles.container}>
            <div className={styles.footerText}>
              New ecosystems are added as models launch on Civitai.
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}

function EcosystemSection({ title, entries }: { title: string; entries: IndexEntry[] }) {
  return (
    <section className={styles.section}>
      <div className={styles.container}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>{title}</h2>
        </div>
        <div className={styles.indexGrid}>
          {entries.map(({ slug, config }) => (
            <NextLink key={slug} href={`/ecosystems/${slug}`} className={styles.indexCard}>
              <div className={styles.indexCardHead}>
                <span className={styles.indexCardName}>
                  {config.name}
                  {config.isNew && (
                    <span className={styles.newBadge} style={{ marginLeft: 8 }}>
                      New
                    </span>
                  )}
                </span>
                <span className={styles.badge}>
                  {config.modality === 'video' ? 'Video' : 'Image'}
                </span>
              </div>
              <span className={styles.indexCardDesc}>{firstSentence(config.hero.intro)}</span>
            </NextLink>
          ))}
        </div>
      </div>
    </section>
  );
}
