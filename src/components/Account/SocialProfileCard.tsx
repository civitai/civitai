import {
  Alert,
  Button,
  Card,
  Center,
  Divider,
  Group,
  Loader,
  Select,
  Stack,
  Title,
} from '@mantine/core';
import { LinkType } from '@prisma/client';
import React, { useState } from 'react';

import { SocialLink } from '~/components/Account/SocialLink';
import { SocialLinkModal } from '~/components/Account/SocialLinkModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { sortDomainLinks } from '~/utils/domain-link';
import { titleCase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export function SocialProfileCard() {
  const user = useCurrentUser();

  const [selectedLink, setSelectedLink] = useState<{
    id?: number;
    type: LinkType;
    url?: string;
  }>();

  // const utils = trpc.useContext();
  const { data, isLoading } = trpc.userLink.getAll.useQuery(
    { userId: user?.id },
    {
      enabled: !!user,
      select: (data) => {
        return {
          social: data?.filter((x) => x.type === LinkType.Social),
          sponsorship: data?.filter((x) => x.type === LinkType.Sponsorship),
        };
      },
    }
  );
  const { data: leaderboardPositions = [], isLoading: loadingLeaderboardPositions } =
    trpc.leaderboard.getLeaderboardPositions.useQuery(
      { userId: user?.id },
      {
        enabled: !!user,
      }
    );

  const updateUserMutation = trpc.user.update.useMutation({
    onSuccess() {
      user?.refresh?.();
    },
  });

  if (!user) return null;

  const renderLinks = (type: LinkType) => {
    const links = type === LinkType.Social ? data?.social : data?.sponsorship;
    return (
      <Card withBorder>
        <Card.Section withBorder p="sm">
          <Group position="apart">
            <Title order={5}>{type} Links</Title>
            <Button compact onClick={() => setSelectedLink({ type })}>
              Add Link
            </Button>
          </Group>
        </Card.Section>
        <Card.Section p="sm">
          {isLoading ? (
            <Center p="md">
              <Loader />
            </Center>
          ) : !links?.length ? (
            <Alert>You have not added any {type.toLowerCase()} links</Alert>
          ) : (
            <div>
              {sortDomainLinks(links).map((link, index) => (
                <React.Fragment key={link.id}>
                  <SocialLink link={link} setSelected={setSelectedLink} />
                  {index < links.length - 1 && <Divider p={0} my="xs" />}
                </React.Fragment>
              ))}
            </div>
          )}
        </Card.Section>
      </Card>
    );
  };

  const leaderboardOptions = leaderboardPositions.map(({ leaderboardId }) => ({
    label: titleCase(leaderboardId),
    value: leaderboardId,
  }));

  return (
    <>
      <Card withBorder>
        <Stack>
          <Title order={2}>Creator Profile</Title>
          {renderLinks(LinkType.Social)}
          {renderLinks(LinkType.Sponsorship)}

          <Select
            label="Leaderboard Showcase"
            placeholder="Select a leaderboard"
            description="Choose which leaderboard badge to display on your profile card"
            name="leaderboardShowcase"
            data={leaderboardOptions}
            value={user.leaderboardShowcase}
            onChange={(value: string | null) =>
              updateUserMutation.mutate({
                id: user.id,
                leaderboardShowcase: value,
              })
            }
            disabled={loadingLeaderboardPositions}
            searchable={leaderboardPositions.length > 10}
            clearable
          />
        </Stack>
      </Card>
      <SocialLinkModal selected={selectedLink} onClose={() => setSelectedLink(undefined)} />
    </>
  );
}
