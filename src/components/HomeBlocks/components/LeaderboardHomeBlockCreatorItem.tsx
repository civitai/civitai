import { Box, createStyles, Grid, Group, Stack, Text } from '@mantine/core';
import { IconCrown, IconTrophy } from '@tabler/icons-react';
import Link from 'next/link';

import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { LeaderboardGetModel } from '~/types/router';
import { numberWithCommas } from '~/utils/number-helpers';

const useStyles = createStyles(() => ({
  wrapper: {
    minHeight: 42,
  },
}));

export const LeaderHomeBlockCreatorItem = ({
  data: { position, user, score },
}: {
  data: LeaderboardGetModel;
}) => {
  const { classes, theme } = useStyles();

  const isTop3 = position <= 3;
  const iconColor = [
    theme.colors.yellow[5], // Gold
    theme.colors.gray[5], // Silver
    theme.colors.orange[5], // Bronze
  ][position - 1];

  const link = `/user/${user.username}`;

  return (
    <div className={classes.wrapper}>
      <Link href={link}>
        <Box>
          <Grid align="center">
            <Grid.Col span={1}>
              <Text>{position}</Text>
            </Grid.Col>
            <Grid.Col span={9}>
              <Group spacing="xs">
                <UserAvatar
                  avatarProps={{
                    radius: 'md',
                  }}
                  user={user}
                  textSize="lg"
                  size="md"
                />
                <Stack spacing={4}>
                  <Text>{user.username}</Text>
                  <Group spacing={4}>
                    <IconTrophy size={12} />
                    <Text size="xs">{numberWithCommas(score)}</Text>
                  </Group>
                </Stack>
              </Group>
            </Grid.Col>
            <Grid.Col span={2}>
              <Stack align="flex-end">
                {/*{false && <EdgeImage src={user} width={24} />}*/}
                {isTop3 && <IconCrown size={24} color={iconColor} style={{ fill: iconColor }} />}
              </Stack>
            </Grid.Col>
          </Grid>
        </Box>
      </Link>
    </div>
  );
};
