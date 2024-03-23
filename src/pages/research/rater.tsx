import {
  Container,
  Chip,
  Group,
  Stack,
  Paper,
  Card,
  Title,
  Text,
  Badge,
  Button,
  Skeleton,
  Box,
  Kbd,
  HoverCard,
  ActionIcon,
  Tooltip,
  Popover,
} from '@mantine/core';
import { useListState, useLocalStorage } from '@mantine/hooks';
import { useEffect, useState } from 'react';
import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { RaterImage } from '~/server/routers/research.router';
import { trpc } from '~/utils/trpc';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import useSound from 'use-sound';
import Lottie from 'react-lottie';
import * as levelAnimation from '~/utils/lotties/level-up-animation.json';
import {
  IconArrowBackUp,
  IconVolume,
  IconVolumeOff,
  IconSword,
  IconStarFilled,
  IconHelpHexagon,
} from '@tabler/icons-react';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';

const NsfwLevel = {
  PG: 1,
  PG13: 2,
  R: 4,
  X: 8,
  XXX: 16,
  Blocked: 32,
} as const;
const NsfwNumMap = Object.fromEntries(
  Object.entries(NsfwLevel).map(([key, value]) => [value, key])
);

const keyMap = {
  PG: '1',
  PG13: '2',
  R: '3',
  X: '4',
  XXX: '5',
  Blocked: '6',
} as const;

const LEVEL_BASE_RATINGS = 8; // Base number of ratings needed for the first level
const LEVEL_GROWTH_RATE = 1.15; // Growth rate for the exponential curve
function calculateLevelProgression(totalRatings: number) {
  // Calculate current level based on total ratings
  let level = 0;
  let ratingsForNextLevel = LEVEL_BASE_RATINGS;

  while (totalRatings >= ratingsForNextLevel) {
    totalRatings -= ratingsForNextLevel;
    level++;
    ratingsForNextLevel = Math.floor(LEVEL_BASE_RATINGS * Math.pow(LEVEL_GROWTH_RATE, level));
  }

  // Calculate number of additional ratings needed for next level
  const ratingsNeededForNextLevel = ratingsForNextLevel - totalRatings;
  const ratingsInLevel = ratingsForNextLevel - ratingsNeededForNextLevel;
  const progress = Math.round((ratingsInLevel / ratingsForNextLevel) * 100);

  return { level, ratingsForNextLevel, ratingsInLevel, progress };
}

let toSet: Record<number, number> = {};
let toSetTimeout: any;
let levelTimeout: any;
let ratingTimeout: any;

const pointSound = '/sounds/point.mp3';
const levelSound = '/sounds/level-up.mp3';
const undoSound = '/sounds/undo.mp3';

export default function Rater() {
  // Keep track of rater state
  const [muted, setMuted] = useLocalStorage<boolean>({ key: 'rater-muted', defaultValue: false });
  const [isLevelingUp, setIsLevelingUp] = useState(false);
  const [level, setLevel] = useLocalStorage<number>({
    key: 'rater-level',
    defaultValue: NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R,
  });
  const [cursor, setCursor] = useLocalStorage<number>({
    key: 'rater-cursor',
    defaultValue: undefined,
  });

  // Prep Sounds
  const [playPoint] = useSound(pointSound, { volume: 0.5 });
  const [playLevel] = useSound(levelSound, { volume: 0.5 });
  const [playUndo] = useSound(undoSound, { volume: 0.3 });

  // Get Status
  const queryUtils = trpc.useContext();
  const { data: status } = trpc.research.raterGetStatus.useQuery();
  function incrementCount(incrementBy = 1) {
    queryUtils.research.raterGetStatus.setData(undefined, (prev) => ({
      ...prev,
      count: (prev?.count ?? 0) + incrementBy,
    }));
  }

  // Get progression
  const progression = status ? calculateLevelProgression(status.count) : undefined;
  function levelUp() {
    setIsLevelingUp(true);
    if (!muted) playLevel();
    levelTimeout && clearTimeout(levelTimeout);
    levelTimeout = setTimeout(() => setIsLevelingUp(false), 2500);
  }

  // Get images
  const [pendingImages, pendingImagesHandlers] = useListState<RaterImage>([]);
  const [prevImages, prevImagesHandlers] = useListState<RaterImage>([]);
  const image = pendingImages[0];
  const { data } = trpc.research.raterGetImages.useQuery(
    { level, cursor },
    {
      enabled: pendingImages.length < 5,
    }
  );
  useEffect(() => {
    if (!data) return;
    pendingImagesHandlers.append(...data);
    setCursor(data[data.length - 1]?.id);
  }, [data]);
  function addToHistory(image: RaterImage) {
    prevImagesHandlers.prepend(image);
    if (prevImages.length > 10) prevImagesHandlers.pop();
  }

  // Handle level setting
  const setRatingsMutation = trpc.research.raterSetRatings.useMutation();
  function handleSetLevel(level: number) {
    if (!image) return;
    // Set image level
    image.nsfwLevel = level;
    const ratingElement = document.getElementById('rating')!;
    ratingElement.innerText = NsfwNumMap[level];
    ratingElement.style.display = 'block';
    ratingTimeout && clearTimeout(ratingTimeout);
    ratingTimeout = setTimeout(() => {
      ratingElement.style.display = 'none';
    }, 200);

    // Play sound
    if (!muted) playPoint();

    // Check for level up
    const shouldLevelUp =
      progression && progression.ratingsInLevel + 1 >= progression.ratingsForNextLevel;
    if (shouldLevelUp) levelUp();

    // Increment count
    incrementCount();

    // Remove image from pending
    addToHistory(image);
    pendingImagesHandlers.shift();

    // Set rating
    toSet[image.id] = level;
    toSetTimeout && clearTimeout(toSetTimeout);
    toSetTimeout = setTimeout(() => {
      // Send rating after 1s debounce
      setRatingsMutation.mutate({ ratings: toSet });
      toSet = {};
    }, 1000);
  }

  // Handle Undo
  function undoRating() {
    const lastImage = prevImages.shift();
    if (lastImage) {
      pendingImagesHandlers.prepend(lastImage);
      incrementCount(-1);
      if (!muted) playUndo();
    }
  }

  // Handle skipping
  function skipImage() {
    if (!image) return;
    addToHistory(image);
    pendingImagesHandlers.shift();
  }

  // Handle level change
  function changeLevel(level: number) {
    setLevel((prev) => {
      if (prev & level) {
        return prev & ~level;
      } else {
        return prev | level;
      }
    });
    pendingImagesHandlers.setState([]);
  }

  // Hotkey hooking
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!image) return;
      if (event.key === '1') handleSetLevel(NsfwLevel.PG);
      if (event.key === '2') handleSetLevel(NsfwLevel.PG13);
      if (event.key === '3') handleSetLevel(NsfwLevel.R);
      if (event.key === '4') handleSetLevel(NsfwLevel.X);
      if (event.key === '5') handleSetLevel(NsfwLevel.XXX);
      if (event.key === 'ArrowRight' || event.code === 'Space') skipImage();
      if (event.ctrlKey && event.key === 'z') undoRating();
      if (event.ctrlKey && event.shiftKey && event.key === 'Enter') levelUp();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [image]);

  return (
    <Container size="xl">
      {isLevelingUp && (
        <Card
          p="md"
          radius="lg"
          shadow="xl"
          withBorder
          style={{
            position: 'fixed',
            top: 200,
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            overflow: 'visible',
            animation: 'fadeOut 500ms ease-in 2s forwards',
          }}
        >
          <Lottie
            options={{ animationData: levelAnimation, loop: false }}
            height={300}
            style={{ marginTop: -210 }}
          />
          <Text size={48} ta="center" weight={500} mt={-90} mb={10} lh={1}>
            Level up!
          </Text>
        </Card>
      )}
      <Stack spacing="md" w="100%" align="center">
        <Group align="flex-end" w="100%">
          <Title order={1} lh={1}>
            Rater
          </Title>
          {progression && (
            <HoverCard withArrow>
              <HoverCard.Target>
                <Badge
                  size="lg"
                  sx={(theme) => ({
                    position: 'relative',
                    cursor: 'default',
                    border: `1px solid ${theme.colors.blue[5]}`,
                    paddingLeft: 5,
                    backgroundColor:
                      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[0],
                    div: {
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      bottom: 0,
                      backgroundColor: theme.colors.blue[5],
                      opacity: 0.3,
                    },
                    span: {
                      display: 'flex',
                      alignItems: 'center',
                    },
                    svg: {
                      marginRight: 5,
                    },
                  })}
                >
                  <IconStarFilled strokeWidth={2.5} size={15} />
                  Level {progression.level + 1}
                  <Box style={{ width: progression.progress + '%' }} />
                </Badge>
              </HoverCard.Target>
              <HoverCard.Dropdown px="xs" py={3} color="gray">
                <Stack spacing={0}>
                  <Group spacing={4}>
                    <Text size="xs" color="blue.4" weight="bold" tt="uppercase">
                      next level
                    </Text>
                    <Text size="xs" weight={500}>
                      {progression.ratingsInLevel} / {progression.ratingsForNextLevel}
                    </Text>
                  </Group>
                  <Group spacing={4}>
                    <Text size="xs" color="blue.4" weight="bold" tt="uppercase">
                      Total ratings
                    </Text>
                    <Text size="xs" weight={500}>
                      {status?.count ?? 0}
                    </Text>
                  </Group>
                </Stack>
              </HoverCard.Dropdown>
            </HoverCard>
          )}
          <Group ml="auto" spacing={4}>
            <Text weight="bold" size="xs">
              Show:{' '}
            </Text>
            {Object.entries(NsfwLevel)
              .filter(([key]) => key !== 'Blocked')
              .map(([key, value]) => (
                <Chip
                  size="xs"
                  radius="xs"
                  checked={(level & value) !== 0}
                  onChange={() => changeLevel(value)}
                  key={key}
                >
                  {key}
                </Chip>
              ))}
          </Group>
        </Group>
        <Box
          sx={(theme) => ({
            height: 600,
            display: 'flex',
            position: 'relative',
            img: {
              height: 'auto',
              width: 'auto',
              maxHeight: '100%',
              maxWidth: '100%',
              objectFit: 'contain',
              top: '50%',
              left: '50%',
              borderRadius: theme.radius.sm,
              boxShadow: theme.shadows.md,
            },
          })}
        >
          {image ? (
            <EdgeMedia src={image?.url} width={700} />
          ) : (
            <Skeleton height={600} width={600}></Skeleton>
          )}
          <Card
            id="rating"
            withBorder
            shadow="sm"
            radius="sm"
            sx={(theme) => ({
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%,-50%)',
              zIndex: 10,
              fontSize: 42,
              opacity: 0.9,
              minWidth: 50,
              padding: '2px 10px 6px !important',
              lineHeight: 1,
              textAlign: 'center',
              fontWeight: 500,
            })}
            style={{ display: 'none' }}
          >
            PG
          </Card>
        </Box>

        <Stack spacing="xs" align="center">
          <Group spacing={4}>
            <Tooltip label="Undo" position="top" withArrow>
              <Button onClick={undoRating} variant="default" px="xs" disabled={!prevImages.length}>
                <IconArrowBackUp />
              </Button>
            </Tooltip>
            <Button.Group>
              {Object.entries(NsfwLevel).map(([key, value]) => (
                <Button
                  key={key}
                  variant={(image?.nsfwLevel & value) !== 0 ? 'filled' : 'default'}
                  onClick={() => handleSetLevel(value)}
                >
                  {key}
                </Button>
              ))}
            </Button.Group>
            <Button onClick={skipImage} variant="default">
              Skip
            </Button>
          </Group>
          <Group w="100%" spacing={5}>
            <Text size="xs" mr="auto">
              <Kbd>1-6</Kbd> to rate, <Kbd>Space</Kbd> to skip, <Kbd>Ctrl</Kbd>+<Kbd>Z</Kbd> to undo
            </Text>
            <ActionIcon size="xs" onClick={() => setMuted((x) => !x)} color="dark">
              {muted ? <IconVolumeOff strokeWidth={2.5} /> : <IconVolume strokeWidth={2.5} />}
            </ActionIcon>
            <Popover width={300} withArrow>
              <Popover.Target>
                <ActionIcon size="xs" color="dark">
                  <IconHelpHexagon strokeWidth={2.5} />
                </ActionIcon>
              </Popover.Target>
              <Popover.Dropdown>
                <Text color="orange" weight={500}>
                  What is this?
                </Text>
                <Text
                  size="sm"
                  lh={1.3}
                >{`We're working on improving our automated content moderation system. We need your help to improve our data! Please assign the rating you think best fits the content`}</Text>
              </Popover.Dropdown>
            </Popover>
          </Group>
        </Stack>
      </Stack>
    </Container>
  );

  return <div>Rater</div>;
}
