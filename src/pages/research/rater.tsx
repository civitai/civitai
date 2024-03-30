import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  Chip,
  createStyles,
  Group,
  HoverCard,
  Kbd,
  keyframes,
  Loader,
  Popover,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import {
  IconArrowBackUp,
  IconCrown,
  IconExternalLink,
  IconFlag,
  IconHelpHexagon,
  IconRotate,
  IconStarFilled,
  IconVolume,
  IconVolumeOff,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import Lottie from 'react-lottie';
import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { openBrowsingLevelGuide } from '~/components/Dialog/dialog-registry';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useGameSounds } from '~/hooks/useGameSounds';
import { RaterImage } from '~/server/routers/research.router';
import { calculateLevelProgression } from '~/server/utils/research-utils';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getRandom } from '~/utils/array-helpers';
import { getRandomBool } from '~/utils/boolean-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import * as levelAnimation from '~/utils/lotties/level-up-animation.json';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

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

const levelPlayBackRates: Record<string, number> = {
  [NsfwLevel.PG]: 1.4,
  [NsfwLevel.PG13]: 1.2,
  [NsfwLevel.R]: 1,
  [NsfwLevel.X]: 0.8,
  [NsfwLevel.XXX]: 0.7,
};

const explanationMap: Record<string, string> = {
  PG: 'Safe for all ages',
  PG13: 'Revealing clothing, violence, and light gore',
  R: 'Adult themes and situations, partial nudity, graphic violence and death',
  X: 'Graphic nudity, adult objects and settings',
  XXX: 'Sexual content and activity',
  Blocked: 'Violates our terms of service',
};

let toSet: Record<number, number> = {};
let trackId: string | undefined;
let toSetTimeout: any;
let levelTimeout: any;
let ratingTimeout: any;
const pendingImages: RaterImage[] = [];
const prevImages: RaterImage[] = [];
const defaultNsfwLevel = NsfwLevel.PG13;
type SanityStatus = 'clear' | 'challenge' | 'assessing' | 'insane';

const FORCED_DELAY = 200;
const imgState = {
  ready: false,
  timeout: undefined as any,
  failedCount: 0,
  readyTime: new Date(),
};
function imgReady(set?: boolean) {
  if (set === undefined) {
    if (imgState.ready === false) imgState.failedCount++;
    return imgState.ready;
  }

  if (set === true && !imgState.ready) {
    if (imgState.timeout) clearTimeout(imgState.timeout);
    const waitEl = document.getElementById('waitIndicator')!;
    const delay = FORCED_DELAY * (imgState.failedCount + 1);
    if (delay > FORCED_DELAY) {
      waitEl.style.display = 'block';
      waitEl.style.setProperty('--animation-duration', `${delay}ms`);
    }
    imgState.timeout = setTimeout(() => {
      imgState.ready = set;
      imgState.failedCount = Math.max(0, imgState.failedCount - 1);
      waitEl.style.display = 'none';
    }, delay);
  } else imgState.ready = set;
  return set;
}

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    if (!session)
      return {
        redirect: {
          destination: getLoginLink({
            returnUrl: ctx.req.url,
            reason: 'rater',
          }),
          permanent: false,
        },
      };
  },
});

export default function Rater() {
  const { classes } = useStyles();

  // Image Ref
  const imageRef = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    const [ref] = imageRef;
    if (!ref) return;
    ref.onload = () => imgReady(true);
    if (ref.complete) imgReady(true);
  }, [imageRef]);

  // Keep track of rater state
  const [muted, setMuted] = useLocalStorage<boolean>({ key: 'rater-muted', defaultValue: false });
  const [isLevelingUp, setIsLevelingUp] = useState(false);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [level, setLevel] = useState<number | undefined>(undefined);
  const [sanityStatus, setSanityStatus] = useState<SanityStatus>('clear');
  const isSanityCheck = sanityStatus === 'challenge';
  const [rated, setRated] = useState<number>(0);
  const [strikes, setStrikes] = useState<number>(0);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const storedLevel = localStorage.getItem('rater-level');
    if (storedLevel && storedLevel !== '1') setLevel(parseInt(storedLevel));
    else setLevel(defaultNsfwLevel);
  }, []);

  // Prep Sounds
  const playSound = useGameSounds();

  // Get Status
  const {
    data: status,
    isLoading,
    refetch: refetchStatus,
  } = trpc.research.raterGetStatus.useQuery();
  const isSane = (isLoading || status?.sane === true) && sanityStatus !== 'insane';
  function incrementCount(incrementBy = 1) {
    setRated((prev) => prev + incrementBy);
  }
  useEffect(() => {
    if (status?.sane === false) setSanityStatus('insane');
    if (status?.strikes) setStrikes(status.strikes);
  }, [status]);

  // Get progression
  const totalRated = (status?.count ?? 0) + rated;
  const progression = status ? calculateLevelProgression(totalRated) : undefined;
  function levelUp() {
    setIsLevelingUp(true);
    if (!muted) playSound('levelUp');
    levelTimeout && clearTimeout(levelTimeout);
    levelTimeout = setTimeout(() => setIsLevelingUp(false), 2500);
  }

  // Get images
  const [image, setImage] = useState<RaterImage | undefined>(undefined);
  const { data } = trpc.research.raterGetImages.useQuery(
    { level: level!, cursor },
    {
      enabled: !isLoading && isSane && !!level && pendingImages.length < 5,
      cacheTime: 0,
    }
  );
  useEffect(() => {
    if (!data) return;
    trackId = data.trackId;
    pendingImages.push(...data.images);
    if (!image) setImage(pendingImages[0]);
    setCursor(data.images[data.images.length - 1].id);
  }, [data]);
  function addToHistory(image: RaterImage) {
    prevImages.unshift(image);
    if (prevImages.length > 10) prevImages.pop();
  }

  // Handle sanity checking
  function giveSanityCheck() {
    if (!image) return;

    setSanityStatus('challenge');
    const sanityImage = getRandom(status!.sanityImages);
    sanityImage.nsfwLevel = image.nsfwLevel;
    setImage(sanityImage);
  }

  function sendRatings() {
    if (!Object.keys(toSet).length) return;
    setRatingsMutation.mutate({ ratings: toSet, trackId: trackId! });
    toSet = {};
  }

  function sendRatingsWithDebounce() {
    toSetTimeout && clearTimeout(toSetTimeout);
    toSetTimeout = setTimeout(sendRatings, 1000);
  }

  // Handle level setting
  const setRatingsMutation = trpc.research.raterSetRatings.useMutation();
  function handleSetLevel(level: number) {
    if (!imgReady()) {
      playSound('buzz');
      return;
    }
    imgReady(false);

    if (!image) return;
    if (isSanityCheck) {
      sendRatings();
      setRatingsMutation.mutate(
        { ratings: { [image.id]: level }, trackId },
        {
          onSuccess: () =>
            setTimeout(() => {
              playSound('challengePass');
              setSanityStatus('clear');
              setImage(pendingImages[0]);
            }, 1000),
          onError: () =>
            setTimeout(() => {
              playSound('challengeFail');
              const newStrikes = strikes + 1;
              setStrikes(newStrikes);
              if (newStrikes >= 3) {
                setSanityStatus('insane');
                setImage(undefined);
              } else {
                setSanityStatus('clear');
                setImage(pendingImages[0]);
              }
            }, 1000),
        }
      );
      playSound('challenge');
      setSanityStatus('assessing');
      return;
    }

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
    if (!muted) {
      if (level === NsfwLevel.Blocked) playSound('buzz');
      else playSound('point', levelPlayBackRates[level]);
    }

    // Check for level up
    const shouldLevelUp =
      progression && progression.ratingsInLevel + 1 >= progression.ratingsForNextLevel;
    if (shouldLevelUp) levelUp();

    // Increment count
    incrementCount();

    // Remove image from pending
    addToHistory(image);
    pendingImages.shift();

    // Determine if we need to sanityCheck
    const shouldSanityCheck = getRandomBool(1 / 50);
    if (shouldSanityCheck) {
      giveSanityCheck();
    } else {
      setImage(pendingImages[0]);
    }

    // Set rating
    toSet[image.id] = level;
    sendRatingsWithDebounce();
  }

  // Handle Restart
  const restartMutation = trpc.research.raterReset.useMutation({
    onSuccess: () => {
      refetchStatus();
      setCursor(undefined);
      setImage(undefined);
      setSanityStatus('clear');
      setRated(0);
      setStrikes(0);
      pendingImages.length = 0;
      prevImages.length = 0;
    },
  });
  function handleRestart() {
    restartMutation.mutate();
  }

  // Handle Undo
  function undoRating() {
    if (isSanityCheck) return;

    const lastImage = prevImages.shift();
    if (lastImage) {
      pendingImages.unshift(lastImage);
      setImage(pendingImages[0]);
      incrementCount(-1);
      if (!muted) playSound('undo');
    }
  }

  // Handle skipping
  function skipImage() {
    if (!image || isSanityCheck) return;

    addToHistory(image);
    pendingImages.shift();
    setImage(pendingImages[0]);
  }

  // Handle level change
  function changeLevel(level: number) {
    if (isSanityCheck) return;

    setLevel((prev) => {
      if (!prev) return level;
      let newLevel = prev & level ? prev & ~level : prev | level;
      if (newLevel === 0) newLevel = defaultNsfwLevel;
      return newLevel;
    });
    pendingImages.length = 0;
    setImage(undefined);
    setCursor(undefined);
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
      if (event.key === '6') handleSetLevel(NsfwLevel.Blocked);
      if (event.key === 'ArrowRight' || event.code === 'Space') skipImage();
      if (event.ctrlKey && event.key === 'z') undoRating();
      if (event.ctrlKey && event.shiftKey && event.key === 'Enter') levelUp();
      if (event.ctrlKey && event.shiftKey && event.key === 'Backspace') giveSanityCheck();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [image]);

  // Handle Loading
  const loading = isLoading ?? restartMutation.isLoading;

  return (
    <Box className={classes.container}>
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
      <Box className={classes.image}>
        {!isSane ? (
          <Card withBorder shadow="sm" radius="sm" className={classes.gameover}>
            <Text color="orange" weight={500} size={36}>
              Game Over
            </Text>
            <Text>You failed 3 rating challenges.</Text>
            <Text mt="sm">
              You made it to{' '}
              <Text component="span" color="blue.4">
                Level {progression?.level}
              </Text>{' '}
              and rated{' '}
              <Text component="span" color="blue.4">
                {numberWithCommas(totalRated)} images
              </Text>
              .
            </Text>
            <Button.Group mt="sm">
              <Button variant="default" leftIcon={<IconRotate />} onClick={handleRestart} fullWidth>
                Restart
              </Button>
              <Button
                component={NextLink}
                color="yellow"
                variant="light"
                rightIcon={<IconCrown />}
                href="/leaderboard/rater"
              >
                Check the Leaderboard
              </Button>
            </Button.Group>
          </Card>
        ) : sanityStatus === 'assessing' ? (
          <Loader size="xl" color="yellow" />
        ) : image ? (
          <EdgeMedia src={image.url} width={700} mediaRef={imageRef} />
        ) : (
          <Loader size="xl" />
        )}
        <Card
          id="rating"
          withBorder
          shadow="sm"
          radius="sm"
          className={classes.levelNotice}
          style={{ display: 'none' }}
        >
          PG
        </Card>
        {!loading && image && sanityStatus !== 'assessing' && (
          <>
            <ActionIcon
              className={classes.link}
              component={NextLink}
              target="_blank"
              href={`/images/${image?.id}`}
              variant="transparent"
            >
              <IconExternalLink />
            </ActionIcon>
          </>
        )}
      </Box>
      <Group align="flex-end" className={classes.rater}>
        <Title order={1} lh={1}>
          Rater
        </Title>
        {progression && (
          <HoverCard withArrow>
            <HoverCard.Target>
              <Badge size="lg" className={classes.raterBadge}>
                <IconStarFilled strokeWidth={2.5} size={15} />
                Level {progression.level}
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
                    {totalRated}
                  </Text>
                </Group>
              </Stack>
            </HoverCard.Dropdown>
          </HoverCard>
        )}
        {!loading && (
          <HoverCard withArrow>
            <HoverCard.Target>
              <Group spacing={4}>
                {Array.from({ length: 3 }).map((_, i) => (
                  <ThemeIcon
                    key={i}
                    color={strikes > i ? 'red' : 'gray'}
                    variant={strikes > i ? 'filled' : 'outline'}
                  >
                    <IconX strokeWidth={2.5} />
                  </ThemeIcon>
                ))}
              </Group>
            </HoverCard.Target>
            <HoverCard.Dropdown px="xs" py={3} color="gray">
              <Text size="xs">
                {3 - strikes} {`more strikes and it's game over!`}
              </Text>
            </HoverCard.Dropdown>
          </HoverCard>
        )}

        {(progression?.level ?? 0) > 20 && (
          <Tooltip label="View Leaderboard">
            <ActionIcon
              size="md"
              component={NextLink}
              href="/leaderboard/rater"
              target="_blank"
              color="yellow"
            >
              <IconCrown />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>

      {isSane && !loading && (
        <>
          <Group ml="auto" spacing={4} className={classes.browsing}>
            <Text weight="bold" size="xs">
              Show:{' '}
            </Text>
            {Object.entries(NsfwLevel)
              .filter(([key]) => key !== 'Blocked' && key !== 'PG')
              .map(([key, value]) => (
                <Chip
                  size="xs"
                  radius="xs"
                  checked={!!level && (level & value) !== 0}
                  onChange={() => changeLevel(value)}
                  key={key}
                >
                  {key}
                </Chip>
              ))}
          </Group>
          <Stack spacing="xs" align="center" className={classes.actionBar}>
            <Card
              id="waitIndicator"
              withBorder
              shadow="sm"
              radius="sm"
              className={classes.waitNotice}
              style={{ display: 'none' }}
            >
              Wait...
            </Card>
            <Group spacing={4}>
              <Tooltip label="Undo" position="top" withArrow>
                <Button
                  onClick={undoRating}
                  variant="default"
                  px="xs"
                  disabled={!prevImages.length}
                >
                  <IconArrowBackUp />
                </Button>
              </Tooltip>
              <Button.Group>
                {Object.entries(NsfwLevel).map(([key, value]) => (
                  <Tooltip
                    key={key}
                    label={explanationMap[key]}
                    position="top"
                    withArrow
                    openDelay={1000}
                    maw={300}
                    multiline
                  >
                    <Button
                      key={key}
                      variant={key === 'Blocked' ? 'filled' : 'default'}
                      color={key === 'Blocked' ? 'red' : undefined}
                      onClick={() => handleSetLevel(value)}
                    >
                      {key === 'Blocked' ? <IconFlag size={18} /> : key}
                    </Button>
                  </Tooltip>
                ))}
              </Button.Group>
              <Button onClick={skipImage} variant="default">
                Skip
              </Button>
            </Group>
            <Group w="100%" spacing={5}>
              <Text size="xs" mr="auto">
                <Kbd>1-6</Kbd> to rate, <Kbd>Space</Kbd> to skip, <Kbd>Ctrl</Kbd>+<Kbd>Z</Kbd> to
                undo
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
                  <Text
                    size="xs"
                    td="underline"
                    color="blue.4"
                    style={{ cursor: 'pointer' }}
                    onClick={() => openBrowsingLevelGuide()}
                  >
                    What do the ratings mean?
                  </Text>
                </Popover.Dropdown>
              </Popover>
            </Group>
          </Stack>
        </>
      )}
    </Box>
  );
}

const useStyles = createStyles((theme) => ({
  container: {
    position: 'relative',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  rater: {
    position: 'absolute',
    top: theme.spacing.xs,
    left: theme.spacing.xs,
    zIndex: 10,
  },
  raterBadge: {
    position: 'relative',
    cursor: 'default',
    border: `1px solid ${theme.colors.blue[5]}`,
    paddingLeft: 5,
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[0],
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
  },
  browsing: {
    position: 'absolute',
    top: theme.spacing.xs,
    right: theme.spacing.xs,
    zIndex: 10,
  },
  image: {
    height: 'calc(100% - 110px)',
    marginTop: theme.spacing.md,
    display: 'flex',
    zIndex: 1,
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
    img: {
      height: 'auto',
      width: 'auto',
      maxHeight: '100%',
      maxWidth: '100%',
      objectFit: 'contain',
      top: '50%',
      left: '50%',
      borderRadius: theme.radius.md,
      boxShadow: theme.shadows.md,
    },
  },
  link: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    zIndex: 10,
  },
  levelNotice: {
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
  },
  waitNotice: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: '100%',
    zIndex: 10,
    fontSize: 24,
    padding: '4px 10px 6px !important',
    lineHeight: 1,
    textAlign: 'center',
    fontWeight: 500,
    [`&:before`]: {
      content: '""',
      position: 'absolute',
      zIndex: 2,
      top: 0,
      left: 0,
      height: '100%',
      width: 0,
      backgroundColor: theme.colors.blue[6],
      opacity: 0,
      animation: `${fillEffect} linear forwards`,
      animationDuration: `var(--animation-duration, ${FORCED_DELAY}ms)`,
    },
  },
  gameover: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%,-50%)',
    width: '400px',
    maxWidth: 'calc(100vw - 30px)',
    zIndex: 10,
    opacity: 0.9,
    textAlign: 'center',
  },
  actionBar: {
    position: 'absolute',
    bottom: theme.spacing.xs,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 10,
  },
}));

const fillEffect = keyframes({
  to: {
    width: '100%',
    opacity: 0.3,
  },
});

setPageOptions(Rater, { withScrollArea: false });
