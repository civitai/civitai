import { Badge, Button, Card, Group, Text } from '@mantine/core';
import { Popover } from '~/components/MantineOverlays';
import { IconArticle, IconPlayerPlay, IconPlus, IconSparkles } from '@tabler/icons-react';
import Link from 'next/link';
import { SellGate } from '~/components/CreatorShop/Services/SellGate';
import { openDialog } from '~/components/Dialog/openDialog';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

/** 2400x800 PG art; its left ~35% is plain purple, where the copy sits from `lg` up. */
export const SERVICES_HERO_IMAGE = 'cad28b23-f957-443e-9370-fc0bfd48a91c';
export const SERVICES_LAUNCH_ARTICLE_URL = '/articles/38740';
export const SERVICES_LAUNCH_VIDEO_URL =
  'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/9b03d364-99ab-408f-ace3-abb4e25c27ff/original=true/hire-a-pro-1080p.mp4';

export function ServicesKickoffHero() {
  return (
    <Card
      radius="md"
      p={0}
      className="relative overflow-hidden border border-[#373a40] lg:aspect-[3/1]"
      style={{ background: 'linear-gradient(135deg, #2c2442 0%, #1a1b1e 100%)' }}
    >
      {/* Below lg the copy would cover the scene, so the art stacks above it, cropped to the scene. */}
      <div className="relative aspect-[2/1] w-full sm:aspect-[5/2] lg:absolute lg:inset-0 lg:aspect-auto lg:h-full">
        <EdgeImage
          src={SERVICES_HERO_IMAGE}
          options={{ width: 1600 }}
          alt=""
          className="absolute inset-0 size-full object-cover object-right"
        />
        <div className="absolute inset-0 hidden bg-gradient-to-r from-[#1e1630]/80 via-[#1e1630]/40 via-40% to-transparent to-60% lg:block" />
      </div>

      <div className="relative flex flex-col gap-4 p-6 lg:h-full lg:w-2/5 lg:justify-center lg:p-8">
        <Badge
          size="md"
          radius="sm"
          leftSection={<IconSparkles size={14} />}
          className="self-start"
          styles={{
            root: {
              backgroundColor: 'rgba(251, 191, 36, 0.15)',
              color: '#fbbf24',
              textTransform: 'none',
              fontWeight: 600,
            },
          }}
        >
          Just opened
        </Badge>
        <div>
          <Text component="h2" fz="xl" fw={700} c="white" mb="xs" className="md:text-3xl">
            Welcome to the new Creator Services Center
          </Text>
          <Text c="gray.3" size="sm" className="leading-relaxed">
            Commission work from Civitai creators, with your Buzz held in escrow until the job is
            done. We&apos;re just opening the doors, so it&apos;s quiet in here while sellers list
            their first services. Got a skill? Be one of the first.
          </Text>
        </div>
        <Group gap="sm">
          <ListServiceButton />
          <Button
            component={Link}
            href={SERVICES_LAUNCH_ARTICLE_URL}
            size="md"
            variant="outline"
            color="gray"
            leftSection={<IconArticle size={18} />}
          >
            Read the article
          </Button>
          <Button
            size="md"
            variant="subtle"
            color="gray"
            leftSection={<IconPlayerPlay size={18} />}
            onClick={() =>
              openDialog(() => import('~/components/Events/ScoredEvent/HatTurfVideoModal'), {
                video: SERVICES_LAUNCH_VIDEO_URL,
                title: 'Hire a Pro',
              })
            }
          >
            Watch the music video
          </Button>
        </Group>
      </div>
    </Card>
  );
}

function ListServiceButton() {
  const currentUser = useCurrentUser();
  const eligibility = trpc.creatorService.getSellEligibility.useQuery(undefined, {
    enabled: !!currentUser,
    staleTime: 5 * 60 * 1000,
  });

  const button = (onClick?: () => void) => (
    <Button
      size="md"
      color="yellow"
      leftSection={<IconPlus size={18} />}
      loading={!!currentUser && eligibility.isLoading}
      onClick={onClick}
    >
      List your service
    </Button>
  );

  if (!currentUser) return <LoginRedirect reason="list-service">{button()}</LoginRedirect>;

  if (eligibility.data && !eligibility.data.canSell)
    return (
      <Popover width={360} position="bottom-start" withArrow shadow="md">
        <Popover.Target>{button()}</Popover.Target>
        <Popover.Dropdown p={0}>
          <SellGate eligibility={eligibility.data} />
        </Popover.Dropdown>
      </Popover>
    );

  if (eligibility.data?.canSell)
    return button(() =>
      openDialog(
        () => import('~/components/CreatorShop/Services/ServiceOfferingFormModal'),
        'ServiceOfferingFormModal'
      )
    );

  return button(() => eligibility.refetch());
}
