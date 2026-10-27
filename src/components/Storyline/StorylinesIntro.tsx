import {
  Button,
  Card,
  CloseButton,
  Group,
  Text,
  ThemeIcon,
  Title,
  UnstyledButton,
} from '@mantine/core';
import {
  IconBook2,
  IconBrush,
  IconGitFork,
  IconPlayerPlayFilled,
  IconRoute,
} from '@tabler/icons-react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import EventVideoModal from '~/components/Events/ScoredEvent/EventVideoModal';
import { StartStorylineButton } from '~/components/Storyline/StartStorylineButton';

export const STORYLINES_INTRO_DISMISSED_KEY = 'storylines-intro-dismissed';

/**
 * The film that explains Storylines, played from the welcome's hero. It is an edge-hosted video's
 * id, as the birthday event's `heroVideo` is. Empty until the film is published: the hero then
 * shows its art with no play button.
 */
export const STORYLINES_INTRO_VIDEO: { id: string; title: string } | null = null;

/** Chapter 2 of the demo story: CivBot and CivChan at rival podiums. An edge image id, like a post's. */
const HERO_ART = 'c86ab790-e9ae-4f8b-9460-bfa77aca52ab';

const steps = [
  {
    icon: IconBook2,
    color: 'blue',
    title: 'Read',
    text: 'Every storyline is a run of posts. Start at chapter 1 and page through like one long post.',
  },
  {
    icon: IconGitFork,
    color: 'violet',
    title: 'Pick a path',
    text: 'At the end of a chapter, the story can fork. See where other readers went and choose yours.',
  },
  {
    icon: IconBrush,
    color: 'teal',
    title: 'Continue it',
    text: 'Add the next chapter from a post of your own. The creator reviews it before it joins.',
  },
] as const;

function openIntroVideo(video: NonNullable<typeof STORYLINES_INTRO_VIDEO>) {
  dialogStore.trigger({ component: EventVideoModal, props: { video } });
}

/** Desktop only: the phone keeps the steps on the first screen. */
function StorylinesIntroHero({ video }: { video: typeof STORYLINES_INTRO_VIDEO }) {
  return (
    <div
      className="relative hidden w-[300px] shrink-0 items-center justify-center self-stretch overflow-hidden rounded-xl bg-gradient-to-br from-[var(--mantine-color-violet-7)] via-[var(--mantine-color-violet-6)] to-[var(--mantine-color-blue-6)] md:flex lg:w-[360px]"
      data-testid="storylines-intro-hero"
    >
      <EdgeMedia
        src={HERO_ART}
        width={720}
        alt=""
        className="absolute inset-0 size-full object-cover"
      />
      {video && (
        <UnstyledButton
          onClick={() => openIntroVideo(video)}
          aria-label={`Watch the ${video.title} video`}
          className="group absolute inset-0 flex flex-col items-center justify-end gap-1.5 pb-4"
        >
          <span className="flex size-[52px] items-center justify-center rounded-full border border-solid border-white/50 bg-white/30 text-white shadow-lg backdrop-blur-md transition-transform group-hover:scale-110">
            <IconPlayerPlayFilled size={22} />
          </span>
          <span className="rounded-full bg-dark-9/40 px-2.5 py-0.5 text-xs font-bold text-white backdrop-blur-md">
            Watch
          </span>
        </UnstyledButton>
      )}
    </div>
  );
}

export function StorylinesIntro({
  dismissed,
  onDismiss,
}: {
  dismissed: boolean;
  onDismiss: () => void;
}) {
  if (dismissed) return null;

  return (
    <Card
      radius="lg"
      withBorder
      className="relative bg-gray-0 p-4 shadow-sm sm:p-6 dark:bg-dark-6"
      component="section"
      aria-labelledby="storylines-intro-title"
    >
      <div className="flex items-stretch gap-6">
        <div className="min-w-0 flex-1">
          <CloseButton
            className="absolute right-2 top-2 z-10"
            aria-label="Dismiss the Storylines welcome"
            onClick={onDismiss}
          />
          <Group gap={6} c="violet" fw={700} fz={13}>
            <IconRoute size={15} aria-hidden />
            New
          </Group>
          <Title
            order={2}
            id="storylines-intro-title"
            fz={{ base: 22, sm: 28 }}
            fw={800}
            mt={4}
            mb={6}
          >
            Welcome to Storylines
          </Title>
          <Text size="sm" c="dimmed" mb="lg">
            Stories told in images, one chapter at a time, by more than one creator. Read one from
            the start, or pick it up where it ends and write what happens next.
          </Text>

          {/* Compact rows on a phone, so the first storylines start on the first screen. */}
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-3 sm:gap-4">
            {steps.map(({ icon: Icon, color, title, text }) => (
              <div
                key={title}
                className="flex items-start gap-3 p-2 sm:rounded-md sm:border sm:border-solid sm:border-gray-3 sm:bg-gray-1 sm:p-4 sm:dark:border-dark-4 sm:dark:bg-dark-5"
              >
                <ThemeIcon variant="light" color={color} radius="xl" className="shrink-0">
                  <Icon size={16} />
                </ThemeIcon>
                <div>
                  <Text fw={700}>{title}</Text>
                  <Text size="sm" c="dimmed">
                    {text}
                  </Text>
                </div>
              </div>
            ))}
          </div>

          <Group mt="lg" gap="sm" wrap="nowrap">
            <StartStorylineButton className="flex-1 sm:flex-none" />
            <Button variant="default" radius="xl" onClick={onDismiss}>
              Got it
            </Button>
          </Group>
        </div>
        <StorylinesIntroHero video={STORYLINES_INTRO_VIDEO} />
      </div>
    </Card>
  );
}
