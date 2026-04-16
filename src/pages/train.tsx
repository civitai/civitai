import {
  Accordion,
  Button,
  Container,
  Group,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconArrowRight, IconBolt, IconRocket, IconSparkles, IconWand } from '@tabler/icons-react';
import Image from 'next/image';
import { Meta } from '~/components/Meta/Meta';
import { NextLink } from '~/components/NextLink/NextLink';
import classes from '~/pages/train.module.scss';

const faqs = [
  {
    q: 'What is a fine-tuned AI model?',
    a: "A fine-tuned AI model is a base image model that's been retrained on a small set of your own example images so it can reliably generate a specific character, style, or concept. On Civitai, it's delivered as a LoRA, a lightweight file that plugs into the generator.",
  },
  {
    q: 'How many images do I need to train?',
    a: 'For most characters and styles, 15 to 30 carefully chosen reference images is enough. More helps for complex concepts; fewer can work when the references are clean and consistent.',
  },
  {
    q: 'How long does training take?',
    a: "Depends on the engine and dataset size. Fast engines run in a fraction of the time of a standard LoRA train; the standard path runs at conventional speeds. You'll get a notification when training completes, no need to watch the screen.",
  },
  {
    q: 'How much does training cost?',
    a: 'Training starts at 500 Buzz, about 50 cents (1,000 Buzz = $1). New Civitai accounts get 500 Buzz on signup, so your first training is effectively covered. Final cost scales with engine, dataset size, and training length, and is quoted to you before you submit. Generating with your trained model afterward runs at standard generator rates.',
  },
  {
    q: 'Do I need a membership to train?',
    a: 'No. Anyone can train an AI model on Civitai with Buzz. A membership is only required to keep a trained model private past the 30-day free window. Without a membership, after 30 days you can still publish the model to the community (free) or train a new one.',
  },
  {
    q: 'What is the 30-day free window?',
    a: "Every model you train on Civitai is yours to use in the generator for 30 days after training, with no subscription required. It's an experiment window, try the model on real work before deciding whether to keep it private (membership) or publish it to the community (free).",
  },
  {
    q: 'Can I download my trained model?',
    a: 'Public models are downloadable by the community. Private models are only accessible to you inside the Civitai generator, so nobody else can load, download, or scrape them.',
  },
  {
    q: 'Why are private models PG and PG-13 only?',
    a: 'Private-mode generation is moderated to PG/PG-13 onsite to keep private training sustainable and abuse-resistant. Public models follow the full site content policy. Choose the mode that fits your work.',
  },
  {
    q: 'What if I stop my membership?',
    a: "You have a 30-day window after your membership ends. Inside that window you can download your private models to keep them offline, publish them to the community so anyone can use them, delete them to remove them immediately, or reactivate your membership to keep them private on Civitai. Anything left private and unreactivated after 30 days is deleted.",
  },
];

const schema = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'FAQPage',
      mainEntity: faqs.map(({ q, a }) => ({
        '@type': 'Question',
        name: q,
        acceptedAnswer: { '@type': 'Answer', text: a },
      })),
    },
    {
      '@type': 'HowTo',
      name: 'How to train a custom AI model on Civitai',
      step: [
        {
          '@type': 'HowToStep',
          name: 'Upload your examples',
          text: 'Drop in 15 to 30 images or video clips of your subject. Civitai auto-captions the set for you.',
        },
        {
          '@type': 'HowToStep',
          name: 'Pick an engine',
          text: 'Choose from the full range of supported open-source base models, or stack your training on top of another fine-tune.',
        },
        {
          '@type': 'HowToStep',
          name: 'Generate onsite',
          text: 'Load your trained model in the Civitai generator and start prompting.',
        },
      ],
    },
  ],
};

export default function TrainPage() {
  return (
    <>
      <Meta
        title="Train Your Own AI Model on Your Characters, Styles and Concepts | Civitai"
        description="Fine-tune a custom AI model on your own characters, styles, or concepts. Get consistent, on-demand generations on Civitai. First training starts around 50 cents, with a 30-day free experiment window. Keep it private with a membership."
        canonical="/train"
        keywords={[
          'train your own AI model',
          'custom AI model',
          'fine-tune AI image model',
          'AI character consistency',
          'custom LoRA training',
          'private AI model',
        ]}
        imageUrl="/images/training-landing/og-train.jpg"
        schema={schema}
      />

      <div className={classes.wrapper}>
        {/* Hero */}
        <section className={classes.hero}>
          <Container size="xl">
            <Stack align="center" gap="md">
              <span className={classes.ribbon}>
                <IconSparkles size={16} /> New accounts get 500 Buzz on signup, enough for a full
                training run
              </span>
              <h1 className={classes.heroTitle}>The AI model that finally knows your thing.</h1>
              <p className={classes.heroSubhead}>
                Train a custom AI model on your own characters, styles, and concepts, then generate
                them on demand inside Civitai. Consistent every time. First training starts around
                50 cents, with a 30-day free window to experiment before you commit.
              </p>
              <Group gap="sm" mt="sm">
                <Button
                  component={NextLink}
                  href="/models/train"
                  size="md"
                  leftSection={<IconBolt size={18} fill="currentColor" />}
                  variant="gradient"
                  gradient={{ from: 'yellow.4', to: 'orange.5', deg: 135 }}
                >
                  Train a Model
                </Button>
              </Group>

              <div className={classes.heroGrid}>
                <div className={classes.heroTile}>
                  <Image
                    src="/images/training-landing/hero-stock-inconsistent.jpg"
                    alt="Eight portraits of the same character produced by a stock AI model, visibly drifting in face, outfit, and art style."
                    width={1024}
                    height={576}
                    sizes="(max-width: 768px) 100vw, 512px"
                  />
                  <div className={classes.heroTileLabel}>Stock model, drifting every render</div>
                </div>
                <div className={classes.heroTile}>
                  <Image
                    src="/images/training-landing/hero-trained-consistent.jpg"
                    alt="Eight consistent, on-model portraits of the same character produced by a custom-trained AI model on Civitai."
                    width={1024}
                    height={576}
                    sizes="(max-width: 768px) 100vw, 512px"
                    priority
                  />
                  <div className={classes.heroTileLabel}>
                    Your trained model, same character every time
                  </div>
                </div>
              </div>
            </Stack>
          </Container>
        </section>

        {/* Social proof strip */}
        <div className={classes.socialProof}>
          <Container size="lg">
            <Text>
              <strong>Over 50,000 AI models trained on Civitai every month.</strong>
            </Text>
          </Container>
        </div>

        {/* §2 — Why stock models fail */}
        <section className={classes.section}>
          <Container size="md">
            <h2 className={classes.sectionTitle}>
              Why stock AI models miss, and why training your own fixes it.
            </h2>
            <Stack gap="md" maw={720} mx="auto">
              <Text c="dimmed" fz="lg" style={{ lineHeight: 1.65 }}>
                You&apos;ve been sketching the same character for a year. You have a style people
                recognized before you had a name for it. You have a concept nobody else has
                trained. Stock models don&apos;t know any of that. They give you a close cousin.
                They give you a guess.
              </Text>
              <Text c="dimmed" fz="lg" style={{ lineHeight: 1.65 }}>
                You write a 400-word prompt to get the character right. You regenerate nine times
                to get one usable frame. You finally get the face right, but the jacket changes.
                You fix the jacket and the style evaporates. You open a commercial image-editor,
                pay per edit, and still end up with a jawline that drifts every third generation.
              </Text>
              <p className={classes.bigQuote}>
                <span>The problem isn&apos;t your prompt.</span>
                <span>
                  The problem is that the model has never seen the thing you&apos;re actually
                  trying to make.
                </span>
              </p>
            </Stack>
          </Container>
        </section>

        {/* §3 — What is a fine-tuned model */}
        <section className={`${classes.section} ${classes.sectionAlt}`}>
          <Container size="md">
            <h2 className={classes.sectionTitle}>What is a fine-tuned AI model (LoRA)?</h2>
            <Stack gap="md" maw={720} mx="auto">
              <Text fz="lg" style={{ lineHeight: 1.65 }}>
                Big open-source image models have seen millions of paintings, photographs,
                characters, and scenes. But they&apos;ve never seen <em>your</em> character,{' '}
                <em>your</em> palette, or the jacket you designed.
              </Text>
              <Text fz="lg" style={{ lineHeight: 1.65 }}>
                A <strong>fine-tuned model</strong> solves that. You take a base model that already
                understands images in general, and you show it a small, focused set of examples,
                usually 15 to 30. Training nudges the model until it can reliably reproduce
                whatever those examples have in common. What you&apos;re left with is a{' '}
                <strong>LoRA</strong>, a lightweight add-on that plugs into the base model and
                teaches it one new trick.
              </Text>
              <p className={classes.bigQuote}>
                <span>A general model learns general things.</span>
                <span>
                  A fine-tuned model learns <em>your</em> thing.
                </span>
              </p>
              <Text ta="center" c="dimmed" fz="md" fs="italic">
                Think of it as a generator that&apos;s read your notes.
              </Text>
            </Stack>

            <img
              src="/images/training-landing/diagram-finetune.png"
              alt="Diagram showing how fine-tuning works: a base model plus your example images produces a fine-tuned model."
              className={classes.diagramImage}
              loading="lazy"
            />
          </Container>
        </section>

        {/* §4 — Benefits */}
        <section className={classes.section}>
          <Container size="lg">
            <h2 className={classes.sectionTitle}>What training your own model unlocks.</h2>
            <div className={classes.benefitGrid}>
              <div className={classes.benefitCard}>
                <Image
                  src="/images/training-landing/benefit-consistency.jpg"
                  alt="Nine consistent portraits of the same character, showing perfect character consistency across lighting, pose, and expression."
                  width={1024}
                  height={1024}
                  sizes="(max-width: 768px) 100vw, 480px"
                />
                <div className={classes.benefitBody}>
                  <div className={classes.benefitTitle}>
                    Character consistency that doesn&apos;t drift
                  </div>
                  <div className={classes.benefitText}>
                    Same jaw, same jacket, same scar, from key art to the fifteenth panel. No more
                    &ldquo;close enough&rdquo; across seeds, sessions, or months.
                  </div>
                </div>
              </div>
              <div className={classes.benefitCard}>
                <Image
                  src="/images/training-landing/benefit-style.jpg"
                  alt="The same landscape scene rendered in four distinct artistic styles, demonstrating fine-tuned style capture."
                  width={1024}
                  height={1024}
                  sizes="(max-width: 768px) 100vw, 480px"
                />
                <div className={classes.benefitBody}>
                  <div className={classes.benefitTitle}>A signature style, not a preset</div>
                  <div className={classes.benefitText}>
                    A line weight, a palette, a grain, the look people clock as yours. Train it
                    once and stop describing it every prompt.
                  </div>
                </div>
              </div>
              <div className={classes.benefitCard}>
                <Image
                  src="/images/training-landing/benefit-concept.jpg"
                  alt="An invented mascot creature rendered consistently across four different scenarios, demonstrating a custom concept trained into an AI model."
                  width={1024}
                  height={1024}
                  sizes="(max-width: 768px) 100vw, 480px"
                />
                <div className={classes.benefitBody}>
                  <div className={classes.benefitTitle}>
                    Custom concepts stock models can&apos;t produce
                  </div>
                  <div className={classes.benefitText}>
                    A prop you invented, a creature from your worldbuilding, a mascot, a uniform, a
                    piece of architecture. Fifteen good references can teach the model something
                    the internet has never trained on.
                  </div>
                </div>
              </div>
              <div className={classes.benefitCard}>
                <Image
                  src="/images/training-landing/benefit-economics.jpg"
                  alt="Cost comparison between per-edit commercial AI tools and a flat-rate custom-trained model, where the per-edit curve climbs while the trained-model line stays flat."
                  width={1024}
                  height={1024}
                  sizes="(max-width: 768px) 100vw, 480px"
                />
                <div className={classes.benefitBody}>
                  <div className={classes.benefitTitle}>Predictable, affordable costs</div>
                  <div className={classes.benefitText}>
                    Commercial image-editors bill per edit, and the total climbs every iteration.
                    On Civitai, training starts at <strong>~50¢</strong> and every generation
                    afterward runs at the regular generator rate. Generate{' '}
                    <strong>30 times as many images</strong> for the cost of a single edit on
                    other platforms.
                  </div>
                </div>
              </div>
            </div>
          </Container>
        </section>

        {/* §5 — How training works */}
        <section className={`${classes.section} ${classes.sectionAlt}`}>
          <Container size="lg">
            <h2 className={classes.sectionTitle}>How training works on Civitai.</h2>
            <p className={classes.sectionLead}>
              Three steps. No GPU to rent, no notebook to babysit, no LoRA files to hand-manage.
            </p>
            <div className={classes.steps}>
              <div className={classes.stepCard}>
                <div className={classes.stepNum}>1</div>
                <div className={classes.stepTitle}>Upload your examples</div>
                <div className={classes.stepText}>
                  Drop in 15 to 30 images (or video clips) of your subject. Our trainer reads each
                  one and writes a short caption describing what&apos;s in it. Captions are the
                  text labels the model uses to learn what each image contains. Auto works for
                  most jobs; you can edit captions when you want more precise control.
                </div>
              </div>
              <div className={classes.stepCard}>
                <div className={classes.stepNum}>2</div>
                <div className={classes.stepTitle}>Pick an engine</div>
                <div className={classes.stepText}>
                  Civitai supports the full range of open-source base models, with new engines
                  landing as they ship. You can even fine-tune on top of another fine-tune, stack
                  your training on top of a community favorite and go deeper.
                </div>
              </div>
              <div className={classes.stepCard}>
                <div className={classes.stepNum}>3</div>
                <div className={classes.stepTitle}>Generate onsite</div>
                <div className={classes.stepText}>
                  When training finishes, your model lands in your Civitai library. Load it into
                  the generator like any other model and start prompting.
                </div>
              </div>
            </div>

            <Group justify="center" mt="xl">
              <Button
                component={NextLink}
                href="/models/train"
                size="md"
                variant="gradient"
                gradient={{ from: 'yellow.4', to: 'orange.5', deg: 135 }}
                leftSection={<IconRocket size={18} />}
              >
                Start Training
              </Button>
            </Group>

            <p className={classes.priceCallout}>
              Training starts at <strong>500 Buzz (~50¢)</strong>. New accounts get 500 Buzz on
              signup, enough for a full run. Your first trained model is free to use for 30 days.
            </p>
          </Container>
        </section>

        {/* §6 — 30-day window */}
        <section className={classes.section}>
          <Container size="lg">
            <h2 className={classes.sectionTitle}>Free for 30 days after you train.</h2>
            <p className={classes.sectionLead}>
              Train today, generate with it for 30 days, no subscription required. Keep it after
              that with a Civitai membership.
            </p>

            <div className={classes.timelineWrap}>
              <div className={classes.timeline}>
                <div className={classes.timelineCard}>
                  <div className={classes.timelineLabel}>Day 0</div>
                  <div className={classes.timelineTitle}>Training complete</div>
                  <div className={classes.timelineText}>
                    Your freshly trained model lands in your Civitai library.
                  </div>
                </div>
                <div className={classes.timelineCard}>
                  <div className={classes.timelineLabel}>Day 1 to 30</div>
                  <div className={classes.timelineTitle}>Use it free</div>
                  <div className={classes.timelineText}>
                    Generate with it inside the Civitai generator, no subscription needed. Try it
                    on real work.
                  </div>
                </div>
                <div className={classes.timelineCard}>
                  <div className={classes.timelineLabel}>After Day 30</div>
                  <div className={classes.timelineTitle}>Keep it or publish it</div>
                  <div className={classes.timelineText}>
                    Keep it private with a membership, or publish it to the community for free.
                    Your call.
                  </div>
                </div>
              </div>
            </div>
          </Container>
        </section>

        {/* §7 — Private models + tiers (merged) */}
        <section className={`${classes.section} ${classes.sectionAlt}`}>
          <Container size="lg">
            <h2 className={classes.sectionTitle}>Keep your model private.</h2>
            <p className={classes.sectionLead}>
              You curated the dataset. You designed the character. You own the IP. A private model
              stays on your account, out of the public library, and nobody else can load, scrape,
              or data-mine it. A Civitai membership is how you keep it past the 30-day window. The
              tier decides how many private models you can have in rotation.
            </p>
            <div className={classes.tierGrid}>
              <div className={classes.tierCard}>
                <div className={classes.tierName}>Bronze</div>
                <div className={classes.tierCount}>3</div>
                <Text fz="sm" fw={600} mt={4}>
                  Private models
                </Text>
                <div className={classes.tierBlurb}>
                  A character, a world, a style. Start here.
                </div>
              </div>
              <div className={classes.tierCard}>
                <div className={classes.tierName}>Silver</div>
                <div className={classes.tierCount}>10</div>
                <Text fz="sm" fw={600} mt={4}>
                  Private models
                </Text>
                <div className={classes.tierBlurb}>A full project. A cast. A universe.</div>
              </div>
              <div className={`${classes.tierCard} ${classes.tierGold}`}>
                <div className={classes.tierName}>Gold</div>
                <div className={classes.tierCount}>100</div>
                <Text fz="sm" fw={600} mt={4}>
                  Private models
                </Text>
                <div className={classes.tierBlurb}>
                  A studio&apos;s worth. Series, franchises, clients, experiments, all live at
                  once.
                </div>
              </div>
            </div>
            <Group justify="center" mt="xl" gap="sm">
              <Button
                component={NextLink}
                href="/pricing"
                size="md"
                variant="gradient"
                gradient={{ from: 'yellow.4', to: 'orange.5', deg: 135 }}
              >
                Compare Plans
              </Button>
              <Button
                component={NextLink}
                href="/models/train"
                size="md"
                variant="default"
                rightSection={<IconArrowRight size={16} />}
              >
                Train for ~50¢ first
              </Button>
            </Group>
            <p className={classes.privateFooterNote}>
              Private-mode generation onsite is limited to PG and PG-13.
            </p>
          </Container>
        </section>

        {/* §8 — FAQ */}
        <section className={classes.section}>
          <Container size="md">
            <Stack gap="lg">
              <Title order={2} className={classes.sectionTitle}>
                Frequently asked questions
              </Title>
              <div className={classes.faqWrap}>
                <Accordion variant="default" classNames={{ control: 'py-4' }}>
                  {faqs.map(({ q, a }, index) => (
                    <Accordion.Item key={index} value={`q${index}`}>
                      <Accordion.Control>
                        <Group gap={8}>
                          <Text size="lg" fw={700}>
                            {q}
                          </Text>
                        </Group>
                      </Accordion.Control>
                      <Accordion.Panel>
                        <Text>{a}</Text>
                      </Accordion.Panel>
                    </Accordion.Item>
                  ))}
                </Accordion>
              </div>
            </Stack>
          </Container>
        </section>

        {/* §9 — Closing */}
        <section className={classes.closing}>
          <Container size="md">
            <Title order={2} mb="xs">
              Make the thing only you can make.
            </Title>
            <Text c="dimmed" fz="lg" mb="xl" maw={560} mx="auto">
              The generator already knows a million styles. None of them are yours yet. Train the
              one that is.
            </Text>
            <Group justify="center" gap="sm">
              <Button
                component={NextLink}
                href="/models/train"
                size="lg"
                variant="gradient"
                gradient={{ from: 'yellow.4', to: 'orange.5', deg: 135 }}
                leftSection={<IconWand size={20} />}
              >
                Train Your First Model
              </Button>
            </Group>
          </Container>
        </section>
      </div>
    </>
  );
}
