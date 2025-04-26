import { Box, BoxProps, Stack, Text } from '@mantine/core';
import React, { forwardRef } from 'react';
import styles from './CreatorCard.module.scss';
import { IconChevronDown, IconChevronUp, IconCrown } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { LeaderboardMetrics } from '~/components/Leaderboard/LeaderboardMetrics';
import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { LeaderboardGetModel } from '~/types/router';
import { useInView } from '~/hooks/useInView';
import { useEffect } from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';

const linkQuery: Record<string, string> = {
  overall: '/models',
  overall_nsfw: '/models',
  new_creators: '/models',
  writers: '/articles',
  'images-overall': '/images',
  'images-nsfw': '/images',
  'images-new': '/images',
  'images-funny': '/images',
  'images-rater': '/posts',
  'base model': '/models?tag=base+model',
  style: '/models?tag=style',
  clothing: '/models?tag=clothing',
  character: '/models?tag=character',
  celebrity: '/models?tag=celebrity',
  buildings: '/models?tag=buildings',
  backgrounds: '/models?tag=background',
  car: '/models?tag=vehicle',
};

export interface CreatorCardProps extends BoxProps {
  active?: boolean;
}

export const CreatorCard = forwardRef<HTMLDivElement, CreatorCardProps>((props, ref) => {
  const { active, className, ...others } = props;

  return (
    <Box
      className={`${styles.wrapper} ${styles.creatorCard} ${
        active ? styles.active : ''
      } ${className}`}
      {...others}
      ref={ref}
    />
  );
});

CreatorCard.displayName = 'CreatorCard';

export function CreatorCard({
  data: { position, user, metrics, score, delta },
  index,
}: {
  data: LeaderboardGetModel;
  index: number;
}) {
  const { ref, inView } = useInView();
  const router = useRouter();

  const { position: queryPosition, id: leaderboardId } = router.query as {
    position: string;
    id: string;
  };

  const isTop3 = position <= 3;
  const topClass = isTop3 ? styles[`top${position}`] : '';

  let link = `/user/${user.username}`;
  if (leaderboardId && typeof leaderboardId === 'string') link += linkQuery[leaderboardId] ?? '';

  useEffect(() => {
    if (position === Number(queryPosition))
      document.getElementById(queryPosition)?.scrollIntoView({ block: 'center', inline: 'center' });
  }, [queryPosition]);

  return (
    <div className={styles.wrapper} ref={ref} id={position.toString()}>
      {inView && (
        <Link href={link}>
          <Box
            className={`${styles.creatorCard} ${topClass}`}
            p="sm"
            radius="md"
            shadow="xs"
            withBorder
          >
            <ContainerGrid align="center">
              <ContainerGrid.Col span={2}>
                <Stack align="center" spacing={0} sx={{ position: 'relative' }}>
                  {isTop3 && <IconCrown size={64} className={styles.crown} />}
                  <Text className={styles.position}>{position}</Text>
                  {delta && delta.position !== 0 && (
                    <Text
                      className={`${styles.delta} ${
                        delta.position > 0 ? styles.deltaPositive : styles.deltaNegative
                      }`}
                    >
                      {delta.position > 0 ? (
                        <IconChevronDown strokeWidth={4} size={14} />
                      ) : (
                        <IconChevronUp strokeWidth={4} size={14} />
                      )}
                      {Math.abs(delta.position)}
                    </Text>
                  )}
                </Stack>
              </ContainerGrid.Col>
              <ContainerGrid.Col span={10}>
                <Stack spacing={8}>
                  <UserAvatar user={user} textSize="lg" size="md" withUsername />
                  <LeaderboardMetrics score={score} metrics={metrics} delta={delta?.score} />
                </Stack>
              </ContainerGrid.Col>
            </ContainerGrid>
          </Box>
        </Link>
      )}
    </div>
  );
}


