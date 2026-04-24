import { Button, Group, Stack, Text, Title } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import classes from '~/components/HomeBlocks/HomeBlock.module.scss';
import type { ProfileImage } from '~/server/selectors/image.selector';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';

export type FeaturedCollectionCurator = {
  id: number;
  username?: string | null;
  image?: string | null;
  profilePicture?: ProfileImage | null;
  deletedAt?: Date | null;
  cosmetics?: UserWithCosmetics['cosmetics'] | null;
};

export type FeaturedCollectionHeaderProps = {
  title: string;
  link: string;
  curator?: FeaturedCollectionCurator | null;
};

export function FeaturedCollectionHeader({ title, link, curator }: FeaturedCollectionHeaderProps) {
  const showCurator = !!curator && curator.id !== -1;

  return (
    <Stack gap={4} className={classes.header}>
      <Group gap="xs" wrap="nowrap" align="center">
        <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.12em' }}>
          {showCurator ? 'Curated Collection by' : 'Curated Collection'}
        </Text>
        {showCurator && curator && <UserAvatarSimple {...curator} />}
      </Group>
      <Group justify="space-between" align="center" wrap="wrap" gap="sm">
        <Title className={classes.title} order={2} lineClamp={1} fw={700} m={0}>
          {title}
        </Title>
        <Link legacyBehavior href={link} passHref>
          <Button
            className={classes.expandButton}
            component="a"
            variant="subtle"
            rightSection={<IconArrowRight size={16} />}
          >
            View collection
          </Button>
        </Link>
      </Group>
    </Stack>
  );
}
