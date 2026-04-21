import {
  Alert,
  Button,
  Center,
  Container,
  Group,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconCircleCheck, IconSparkles } from '@tabler/icons-react';
import clsx from 'clsx';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { IsClient } from '~/components/IsClient/IsClient';
import { Meta } from '~/components/Meta/Meta';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import animationClasses from '~/libs/animations.module.scss';

export const GRANNY_GRIPPERS_COSMETIC_ID = 1026;

const DEADLINE = new Date('2026-05-01T23:59:59Z');
// Mystery placeholder shown before the user claims; hides the real art.
const PLACEHOLDER_ART_UUID = '9023ae0d-e80a-40ce-86e6-c12fa08e4f53';
// Real badge art revealed after claim.
const REVEAL_ART_UUID = '5b6e4ec7-b4a7-4044-9f03-c82b64dac830';
const FAREWELL_ARTICLE_URL = '/articles/28893/farewell-civitans';
const ALLY_PARTING_GIFT_URL = '/v/ally-parting-message';
const REVEAL_ANIMATION_MS = 1800;

type Remaining = { days: number; hours: number; minutes: number; seconds: number; done: boolean };

function getRemaining(to: Date): Remaining {
  const ms = to.getTime() - Date.now();
  if (ms <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0, done: true };
  const s = Math.floor(ms / 1000);
  return {
    days: Math.floor(s / 86400),
    hours: Math.floor((s % 86400) / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60,
    done: false,
  };
}

export function GrannyGrippersClaim() {
  return (
    <>
      <Meta title="Unlock Prestige | Civitai" deIndex />
      <IsClient>
        <GrannyGrippersClaimBody />
      </IsClient>
    </>
  );
}

function GrannyGrippersClaimBody() {
  const router = useRouter();
  const previewMode = router.query.preview === '1';
  const queryUtils = trpc.useUtils();
  const { data: status, isLoading } = trpc.user.cosmeticStatus.useQuery(
    { id: GRANNY_GRIPPERS_COSMETIC_ID },
    { enabled: !previewMode }
  );
  const [remaining, setRemaining] = useState<Remaining>(() => getRemaining(DEADLINE));
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [previewClaimed, setPreviewClaimed] = useState(false);
  const [previewEquipped, setPreviewEquipped] = useState(false);

  const claimed = previewMode ? previewClaimed : !!status?.obtained;
  const equipped = previewMode ? previewEquipped : !!status?.equipped;
  const expired = remaining.done && !claimed;

  useEffect(() => {
    if (claimed) return;
    const handle = window.setInterval(() => setRemaining(getRemaining(DEADLINE)), 1000);
    return () => window.clearInterval(handle);
  }, [claimed]);

  const claimMutation = trpc.user.claimCosmetic.useMutation({
    onSuccess: () => {
      setIsUnlocking(true);
      window.setTimeout(async () => {
        await queryUtils.user.cosmeticStatus.invalidate({ id: GRANNY_GRIPPERS_COSMETIC_ID });
        await queryUtils.user.getById.invalidate();
        setIsUnlocking(false);
      }, REVEAL_ANIMATION_MS);
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Unable to unlock',
        error: new Error(error.message),
      });
    },
  });

  const equipMutation = trpc.user.equipCosmetic.useMutation({
    onSuccess: async () => {
      await queryUtils.user.cosmeticStatus.invalidate({ id: GRANNY_GRIPPERS_COSMETIC_ID });
      await queryUtils.user.getById.invalidate();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Unable to equip',
        error: new Error(error.message),
      });
    },
  });

  const handleClaim = () => {
    if (previewMode) {
      setIsUnlocking(true);
      window.setTimeout(() => {
        setPreviewClaimed(true);
        setIsUnlocking(false);
      }, REVEAL_ANIMATION_MS);
      return;
    }
    claimMutation.mutate({ id: GRANNY_GRIPPERS_COSMETIC_ID });
  };

  const handleEquip = () => {
    if (previewMode) {
      setPreviewEquipped(true);
      return;
    }
    equipMutation.mutate({ id: GRANNY_GRIPPERS_COSMETIC_ID });
  };

  if (isLoading && !previewMode) {
    return (
      <Center mt="xl">
        <Loader />
      </Center>
    );
  }

  const artUuid = claimed ? REVEAL_ART_UUID : PLACEHOLDER_ART_UUID;
  const claimInProgress = claimMutation.isLoading || isUnlocking;

  return (
    <Container size="xs" mb="lg">
      <Stack gap={0}>
        <Center
          key={claimed ? 'reveal' : 'mystery'}
          h={200}
          my="lg"
          className={clsx(
            !isUnlocking && animationClasses.jelloFall,
            isUnlocking && animationClasses.vibrate
          )}
        >
          <EdgeMedia
            src={artUuid}
            alt={claimed ? "TheAlly's Granny Grippers" : 'Exclusive profile cosmetic'}
            width={200}
            style={{ height: 200, width: 200, objectFit: 'contain' }}
          />
        </Center>

        <Title order={1} ta="center" mb={5}>
          {claimed
            ? "TheAlly's Granny Grippers"
            : expired
            ? 'The moment has passed'
            : 'Exclusive Profile Cosmetic'}
        </Title>

        {!claimed && !expired && (
          <>
            <Text size="lg" ta="center" mt="md">
              A small thank you to the community from TheAlly. A truly exclusive profile badge,
              designed for individuals of exceptional taste and cultural refinement. This limited
              cosmetic explores themes of mortality, texture, and circulation.
            </Text>
            <Text size="md" ta="center" c="dimmed" mt="sm" fs="italic">
              It&apos;s not for everyone. It&apos;s for true Civitai connoisseurs.
            </Text>
            <Center mt="xl">
              <Text fz={32} fw={600} ff="monospace" ta="center">
                {String(remaining.days).padStart(2, '0')}d{' '}
                {String(remaining.hours).padStart(2, '0')}h{' '}
                {String(remaining.minutes).padStart(2, '0')}m{' '}
                {String(remaining.seconds).padStart(2, '0')}s
              </Text>
            </Center>
            <Text size="xs" ta="center" c="dimmed">
              Available until May 1st
            </Text>
            <Center mt="xl">
              <Button
                onClick={handleClaim}
                size="lg"
                w={300}
                loading={claimInProgress}
                variant="gradient"
                gradient={{ from: 'yellow.7', to: 'yellow.4', deg: 45 }}
              >
                {isUnlocking ? 'Unlocking...' : 'Unlock Prestige Now'}
              </Button>
            </Center>
          </>
        )}

        {claimed && (
          <>
            <Text size="lg" ta="center" mt="md">
              Congratulations, connoisseur. You&apos;re now the proud owner of TheAlly&apos;s Granny
              Grippers. Wear it with pride.
            </Text>
            <Center mt="xl">
              <Alert radius="sm" color="yellow" className="z-10">
                <Group gap="xs" wrap="nowrap" justify="center">
                  <ThemeIcon color="yellow" size="lg">
                    <IconSparkles />
                  </ThemeIcon>
                  <Title order={2}>Prestige unlocked</Title>
                </Group>
              </Alert>
            </Center>
            <Center mt="xl">
              {equipped ? (
                <Alert radius="sm" color="green" className="z-10">
                  <Group gap="xs" wrap="nowrap" justify="center">
                    <ThemeIcon color="green" size="lg">
                      <IconCircleCheck />
                    </ThemeIcon>
                    <Title order={3}>Equipped</Title>
                  </Group>
                </Alert>
              ) : (
                <Button
                  onClick={handleEquip}
                  color="green"
                  size="lg"
                  w={300}
                  loading={equipMutation.isLoading}
                >
                  Equip
                </Button>
              )}
            </Center>
            <Text size="sm" ta="center" c="dimmed" fs="italic" mt="xl">
              But truly, TheAlly wanted to leave you with something meaningful.
              <br />A heartfelt{' '}
              <Text
                component="a"
                href={ALLY_PARTING_GIFT_URL}
                target="_blank"
                rel="noopener noreferrer"
                c="blue.4"
                span
              >
                parting message
              </Text>{' '}
              from him to you.
            </Text>
          </>
        )}

        {expired && (
          <>
            <Text size="lg" ta="center" mt="md">
              The claim window has closed. TheAlly&apos;s farewell cosmetic is no longer available.
            </Text>
            <Center mt="xl">
              <Button component={Link} href={FAREWELL_ARTICLE_URL} size="lg" w={300}>
                Read TheAlly&apos;s farewell
              </Button>
            </Center>
          </>
        )}
      </Stack>
    </Container>
  );
}
