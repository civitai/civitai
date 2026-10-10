import {
  Badge,
  Button,
  CloseButton,
  Container,
  SegmentedControl,
  SimpleGrid,
  Text,
  Title,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import {
  IconBolt,
  IconCheck,
  IconPalette,
  IconPhotoUp,
  IconShieldCheck,
  IconSparkles,
  IconUserCircle,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { NextLink } from '~/components/NextLink/NextLink';
import { useDomainColor } from '~/hooks/useDomainColor';
import { env } from '~/env/client';
import {
  avatarStarterCharacters,
  avatarStartersFor,
  avatarStyleCharacterSrc,
} from '~/shared/constants/avatar-starters';
import {
  AVATAR_WORKFLOW,
  avatarCategories,
  avatarEditModels,
  avatarStyleByKey,
  avatarStyles,
} from '~/shared/constants/avatar-styles.constants';
import { MediaType } from '~/shared/utils/prisma/enums';

const PATH = '/avatar-generator';
const characterName = (character: string) => character[0].toUpperCase() + character.slice(1);

type Character = (typeof avatarStarterCharacters)[number];

/** Read by `useGenerationIngestion`. The first character is every style's 'cover'. */
const generateHref = (styleKey: string | undefined, character: Character) =>
  `/generate?${new URLSearchParams({
    workflow: AVATAR_WORKFLOW,
    ...(styleKey
      ? {
          avatarStyle: styleKey,
          avatarReference:
            character === avatarStarterCharacters[0] ? 'cover' : `starter:${character}`,
        }
      : {}),
  })}`;

const characterOptions = avatarStarterCharacters.map((character) => ({
  value: character,
  label: characterName(character),
}));

const SHOWCASE_STYLES = ['anime-niji', 'pixar-3d', 'watercolor', 'neo-noir', 'voxel', 'chibi'];
/** A few styles from each category for the gallery. */
const STYLES_PER_CATEGORY = 4;

const steps = [
  {
    Icon: IconPhotoUp,
    title: 'Upload a photo',
    text: 'A clear, front-facing portrait works best. One photo is all it takes.',
  },
  {
    Icon: IconPalette,
    title: 'Pick a style',
    text: `Choose from ${avatarStyles.length} styles across anime, cartoon, comics, painting, games, film and more, and pick the colours you want.`,
  },
  {
    Icon: IconSparkles,
    title: 'Generate and refine',
    text: 'Get several takes at once. Refine the one you like until it is right, then set it as your profile picture.',
  },
];

const faq = [
  {
    q: 'What is an AI avatar generator?',
    a: 'It redraws a photo of you in an art style of your choice, keeping your face and features so the avatar still looks like you.',
  },
  {
    q: 'Will the avatar look like me?',
    a: 'Yes. Your photo decides who appears. Style references only set the look; the person in a reference image is never copied onto you.',
  },
  {
    q: 'How many styles are there?',
    a: `${avatarStyles.length} styles in ${avatarCategories.length} groups: ${avatarCategories.join(
      ', '
    )}.`,
  },
  {
    q: 'Which AI models make the avatars?',
    a: `${avatarEditModels
      .map((model) => model.label)
      .join(
        ', '
      )}. Krea 2 is selected by default, and you can switch models in the generator before you generate.`,
  },
  {
    q: 'How much does it cost?',
    a: 'Avatars are paid for with Buzz, like other generations on Civitai. The generator shows the exact cost before you generate.',
  },
  {
    q: 'Can I change an avatar after it is made?',
    a: 'Yes. Press Refine under any result to use it as the starting point for the next round, in the same style or a new one.',
  },
  {
    q: 'Can I use it as my Civitai profile picture?',
    a: 'Yes. Every result has a "Use as profile picture" button.',
  },
  {
    q: 'Are the avatars safe for work?',
    a: 'Avatar generation is built for safe-for-work profile pictures. We scan every result and hold back images our scanning flags as mature. No automated check is perfect, so start from an everyday, fully clothed photo.',
  },
];

const styleSrc = (styleKey: string, character: Character) =>
  avatarStyleCharacterSrc(styleKey, character);

function StyleTile({
  styleKey,
  character,
  selected,
  onSelect,
}: {
  styleKey: string;
  character: Character;
  selected: boolean;
  onSelect: (styleKey: string) => void;
}) {
  const style = avatarStyleByKey.get(styleKey);
  const src = styleSrc(styleKey, character);
  if (!style || !src) return null;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(styleKey)}
      className={clsx(
        'relative flex flex-col overflow-hidden rounded-lg bg-gray-1 text-left transition-shadow dark:bg-dark-6',
        selected
          ? 'ring-4 ring-yellow-5 ring-offset-2 dark:ring-offset-dark-7'
          : 'hover:ring-2 hover:ring-gray-4 dark:hover:ring-dark-3'
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={`${style.name} AI avatar`}
        loading="lazy"
        className="aspect-square w-full object-cover"
      />
      {selected && (
        <span className="absolute right-1.5 top-1.5 rounded-full bg-yellow-5 p-1 text-black">
          <IconCheck size={14} />
        </span>
      )}
      <span className="truncate px-2 py-1.5 text-sm font-medium">{style.name}</span>
    </button>
  );
}

/**
 * Sticky, not fixed: the layout's scroll area is a size container, which pins a fixed box to the
 * content's bottom instead of the screen's.
 */
function SelectedStyleBar({
  styleKey,
  character,
  onClear,
}: {
  styleKey: string;
  character: Character;
  onClear: () => void;
}) {
  const style = avatarStyleByKey.get(styleKey);
  const src = styleSrc(styleKey, character);
  if (!style) return null;
  return (
    <div className="sticky inset-x-0 bottom-0 z-[51] border-y border-gray-3 bg-white/95 pb-[var(--safe-area-inset-bottom-unpaid)] shadow-lg backdrop-blur dark:border-dark-4 dark:bg-dark-7/95">
      <Container size="lg" className="flex items-center gap-3 py-3">
        {src && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" className="size-12 shrink-0 rounded-md object-cover" />
        )}
        <div className="min-w-0 flex-1">
          <Text size="xs" c="dimmed">
            Selected style
          </Text>
          <Text fw={600} truncate>
            {style.name}
          </Text>
        </div>
        <GenerateButton styleKey={styleKey} character={character} label="Create this avatar" />
        <CloseButton aria-label="Clear selected style" onClick={onClear} />
      </Container>
    </div>
  );
}

function GenerateButton({
  label = 'Create your avatar',
  styleKey,
  character = avatarStarterCharacters[0],
}: {
  label?: string;
  styleKey?: string;
  character?: Character;
}) {
  return (
    <Button
      component={NextLink}
      href={generateHref(styleKey, character)}
      color="yellow"
      size="md"
      leftSection={<IconBolt size={18} />}
    >
      {label}
    </Button>
  );
}

export default function AvatarGeneratorPage() {
  const deIndex = useDomainColor() !== 'green';
  const baseUrl = env.NEXT_PUBLIC_BASE_URL ?? 'https://civitai.com';
  const ogStarter = avatarStartersFor(SHOWCASE_STYLES[0])[0];
  const [selectedStyle, setSelectedStyle] = useState<string>();
  // Shared with the generator's style picker, so the person chosen here is the one it previews.
  const [storedCharacter, setCharacter] = useLocalStorage<string>({
    key: 'avatar-style-preview-character',
    defaultValue: avatarStarterCharacters[0],
  });
  const character =
    avatarStarterCharacters.find((c) => c === storedCharacter) ?? avatarStarterCharacters[0];
  const toggleStyle = (styleKey: string) =>
    setSelectedStyle((current) => (current === styleKey ? undefined : styleKey));

  const schema = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: baseUrl },
          {
            '@type': 'ListItem',
            position: 2,
            name: 'AI Avatar Generator',
            item: `${baseUrl}${PATH}`,
          },
        ],
      },
      {
        '@type': 'WebApplication',
        name: 'Civitai AI Avatar Generator',
        url: `${baseUrl}${PATH}`,
        applicationCategory: 'DesignApplication',
        operatingSystem: 'Web browser',
      },
      {
        '@type': 'FAQPage',
        mainEntity: faq.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
    ],
  };

  return (
    <>
      <Meta
        title={`AI Avatar Generator: Turn Your Photo Into ${avatarStyles.length} Art Styles | Civitai`}
        description={`Make an AI avatar from one photo. Pick from ${avatarStyles.length} styles, from anime and 3D animation to watercolour and voxel, refine it, and set it as your profile picture.`}
        canonical={PATH}
        images={
          ogStarter ? { url: ogStarter.colour.url, nsfwLevel: 1, type: MediaType.image } : undefined
        }
        schema={schema}
        deIndex={deIndex}
      />

      {/* Sticky stays inside its parent, so this wrapper ends at the gallery and keeps the bar off the FAQ. */}
      <div>
        <Container size="lg" className="flex flex-col gap-16 pb-16 pt-10">
          <section className="flex flex-col gap-5">
            <nav className="text-sm text-gray-6 dark:text-dark-2">
              <NextLink href="/">Home</NextLink> / <span>AI Avatar Generator</span>
            </nav>
            <Title order={1} className="text-4xl sm:text-5xl">
              AI Avatar Generator
            </Title>
            <Text size="lg" className="max-w-2xl">
              Turn one photo of yourself into an avatar in {avatarStyles.length} art styles. Your
              face stays yours; the style is up to you.
            </Text>
            <div className="flex flex-wrap gap-3">
              <GenerateButton />
              <Button component={NextLink} href="#styles" variant="default" size="md">
                See the styles
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="light" leftSection={<IconPalette size={12} />}>
                {avatarStyles.length} styles
              </Badge>
              <Badge variant="light" leftSection={<IconUserCircle size={12} />}>
                One-click profile picture
              </Badge>
              <Badge variant="light" leftSection={<IconShieldCheck size={12} />}>
                Built for SFW profiles
              </Badge>
            </div>
          </section>

          <section className="flex flex-col gap-4">
            <div>
              <Title order={2}>Same face, any style</Title>
              <Text c="dimmed">
                {characterName(character)}, in six of the {avatarStyles.length} styles. Pick who to
                preview; the whole page follows.
              </Text>
            </div>
            <SegmentedControl
              className="self-start"
              value={character}
              onChange={setCharacter}
              data={characterOptions}
              aria-label="Preview avatars as"
            />
            <SimpleGrid cols={{ base: 2, sm: 3, md: 6 }} spacing="sm">
              {SHOWCASE_STYLES.map((styleKey) => (
                <StyleTile
                  key={styleKey}
                  styleKey={styleKey}
                  character={character}
                  selected={selectedStyle === styleKey}
                  onSelect={toggleStyle}
                />
              ))}
            </SimpleGrid>
          </section>

          <section className="flex flex-col gap-4">
            <Title order={2}>How it works</Title>
            <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="lg">
              {steps.map(({ Icon, title, text }, index) => (
                <div
                  key={title}
                  className="flex flex-col gap-2 rounded-lg border border-gray-3 p-5 dark:border-dark-4"
                >
                  <Icon size={28} className="text-yellow-6" />
                  <Title order={3} className="text-lg">
                    {index + 1}. {title}
                  </Title>
                  <Text size="sm">{text}</Text>
                </div>
              ))}
            </SimpleGrid>
          </section>

          <section id="styles" className="flex scroll-mt-24 flex-col gap-8">
            <div>
              <Title order={2}>Avatar styles</Title>
              <Text c="dimmed">
                Tap a style to pick it. These are a sample from each group; all{' '}
                {avatarStyles.length} are in the generator.
              </Text>
            </div>
            {avatarCategories.map((category) => {
              const styles = avatarStyles.filter((style) => style.category === category);
              if (!styles.length) return null;
              return (
                <div key={category} className="flex flex-col gap-3">
                  <Title order={3} className="text-lg">
                    {category} avatars{' '}
                    <Text span c="dimmed" size="sm">
                      ({styles.length} styles)
                    </Text>
                  </Title>
                  <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
                    {styles.slice(0, STYLES_PER_CATEGORY).map((style) => (
                      <StyleTile
                        key={style.key}
                        styleKey={style.key}
                        character={character}
                        selected={selectedStyle === style.key}
                        onSelect={toggleStyle}
                      />
                    ))}
                  </SimpleGrid>
                </div>
              );
            })}
          </section>
        </Container>
        {selectedStyle && (
          <SelectedStyleBar
            styleKey={selectedStyle}
            character={character}
            onClear={() => setSelectedStyle(undefined)}
          />
        )}
      </div>

      <Container size="lg" className="flex flex-col gap-16 py-10">
        <section className="flex flex-col gap-4">
          <Title order={2}>Frequently asked questions</Title>
          <div className="flex flex-col gap-5">
            {faq.map((item) => (
              <div key={item.q}>
                <Title order={3} className="text-base">
                  {item.q}
                </Title>
                <Text size="sm" className="mt-1">
                  {item.a}
                </Text>
              </div>
            ))}
          </div>
        </section>

        <section className="flex flex-col items-center gap-3 rounded-xl bg-gray-1 px-6 py-10 text-center dark:bg-dark-6">
          <Title order={2}>Make your avatar now</Title>
          <Text>No installation, no GPU. It runs in your browser.</Text>
          <GenerateButton styleKey={selectedStyle} character={character} />
        </section>
      </Container>
    </>
  );
}
