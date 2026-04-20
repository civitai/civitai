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
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconShieldCheck,
  IconSparkles,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { IsClient } from '~/components/IsClient/IsClient';
import { Meta } from '~/components/Meta/Meta';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import animationClasses from '~/libs/animations.module.scss';

export const GRANNY_GRIPPERS_COSMETIC_ID = 1026;

const DEADLINE = new Date('2026-05-01T23:59:59Z');
const BADGE_ART_UUID = '5b6e4ec7-b4a7-4044-9f03-c82b64dac830';
const FAREWELL_ARTICLE_URL = '/articles/28893/farewell-civitans';

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
      <Meta title="Claim Granny Grippers | Civitai" deIndex />
      <IsClient>
        <GrannyGrippersClaimBody />
      </IsClient>
    </>
  );
}

function GrannyGrippersClaimBody() {
  const queryUtils = trpc.useUtils();
  const { data: status, isLoading } = trpc.user.cosmeticStatus.useQuery({
    id: GRANNY_GRIPPERS_COSMETIC_ID,
  });
  const [remaining, setRemaining] = useState<Remaining>(() => getRemaining(DEADLINE));

  const prevented = !!status?.obtained;
  const equipped = !!status?.equipped;
  const expired = remaining.done && !prevented;

  useEffect(() => {
    if (prevented) return;
    const handle = window.setInterval(() => setRemaining(getRemaining(DEADLINE)), 1000);
    return () => window.clearInterval(handle);
  }, [prevented]);

  const claimMutation = trpc.user.claimCosmetic.useMutation({
    onSuccess: async () => {
      await queryUtils.user.cosmeticStatus.invalidate({ id: GRANNY_GRIPPERS_COSMETIC_ID });
      await queryUtils.user.getById.invalidate();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Unable to prevent the grippers',
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
        title: 'Unable to equip the grippers',
        error: new Error(error.message),
      });
    },
  });

  const handlePrevent = () => claimMutation.mutate({ id: GRANNY_GRIPPERS_COSMETIC_ID });
  const handleEquip = () => equipMutation.mutate({ id: GRANNY_GRIPPERS_COSMETIC_ID });

  if (isLoading) {
    return (
      <Center mt="xl">
        <Loader />
      </Center>
    );
  }

  return (
    <Container size="xs" mb="lg">
      <Stack gap={0}>
        {!prevented && !expired && (
          <Center>
            <Alert radius="sm" color="red" className="z-10">
              <Group gap="xs" wrap="nowrap" justify="center">
                <ThemeIcon color="red" size="md" variant="light">
                  <IconAlertTriangle />
                </ThemeIcon>
                <Text size="md" fw={500}>
                  Incoming cosmetic! Act fast!
                </Text>
              </Group>
            </Alert>
          </Center>
        )}

        <Center className={animationClasses.jelloFall} h={180} my="lg">
          <EdgeMedia
            src={BADGE_ART_UUID}
            alt="TheAlly's Granny Grippers"
            width={180}
            style={{ height: 180, width: 180, objectFit: 'contain' }}
          />
        </Center>

        <Title order={1} ta="center" mb={5}>
          {prevented
            ? 'Whew! Close one!'
            : expired
            ? 'Wait... nothing happened?'
            : "TheAlly's Granny Grippers"}
        </Title>

        {!prevented && !expired && (
          <>
            <Text size="lg" ta="center">
              {`You've got until the timer runs out to prevent TheAlly's Granny Grippers from being applied to your profile. Varicose veins. Balls of yarn. Knitting needles. You do not want this.`}
            </Text>
            <Center mt="xl">
              <Text fz={40} fw={600} ff="monospace" ta="center">
                {String(remaining.days).padStart(2, '0')}d{' '}
                {String(remaining.hours).padStart(2, '0')}h{' '}
                {String(remaining.minutes).padStart(2, '0')}m{' '}
                {String(remaining.seconds).padStart(2, '0')}s
              </Text>
            </Center>
            <Center mt="xl">
              <Button
                onClick={handlePrevent}
                size="lg"
                w={300}
                color="red"
                loading={claimMutation.isLoading}
              >
                Prevent!
              </Button>
            </Center>
          </>
        )}

        {prevented && (
          <>
            <Text size="lg" ta="center">
              You successfully dodged TheAlly&apos;s parting gift. The badge is yours now, a quiet
              trophy for your quick reflexes.
            </Text>
            <Center mt="xl">
              <Alert radius="sm" color="green" className="z-10">
                <Group gap="xs" wrap="nowrap" justify="center">
                  <ThemeIcon color="green" size="lg">
                    <IconShieldCheck />
                  </ThemeIcon>
                  <Title order={2}>Prevention successful</Title>
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
          </>
        )}

        {expired && (
          <>
            <Text size="lg" ta="center">
              Timer ran out and... nothing happened. Turns out TheAlly would never do that to you.
              Probably.
            </Text>
            <Center mt="xl">
              <Alert radius="sm" color="yellow" className="z-10">
                <Group gap="xs" wrap="nowrap" justify="center">
                  <ThemeIcon color="yellow" size="lg">
                    <IconSparkles />
                  </ThemeIcon>
                  <Title order={2}>You escaped!</Title>
                </Group>
              </Alert>
            </Center>
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
