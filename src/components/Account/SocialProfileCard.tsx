import { Alert, Button, Card, Center, Divider, Group, Loader, Stack, Title } from '@mantine/core';
import { LinkType } from '@prisma/client';
import { useSession } from 'next-auth/react';
import React, { useState } from 'react';

import { SocialLink } from '~/components/Account/SocialLink';
import { SocialLinkModal } from '~/components/Account/SocialLinkModal';
import { sortDomainLinks } from '~/utils/domain-link';
import { trpc } from '~/utils/trpc';

export function SocialProfileCard() {
  const { data: session } = useSession();

  const [selectedLink, setSelectedLink] = useState<{
    id?: number;
    type: LinkType;
    url?: string;
  }>();

  // const utils = trpc.useContext();
  const { data, isLoading } = trpc.userLink.getAll.useQuery(
    { userId: session?.user?.id },
    {
      select: (data) => {
        return {
          social: data?.filter((x) => x.type === LinkType.Social),
          sponsorship: data?.filter((x) => x.type === LinkType.Sponsorship),
        };
      },
    }
  );

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

  return (
    <>
      <Card withBorder>
        <Stack>
          <Title order={2}>Creator Profile</Title>
          {renderLinks(LinkType.Social)}
          {renderLinks(LinkType.Sponsorship)}
        </Stack>
      </Card>
      <SocialLinkModal selected={selectedLink} onClose={() => setSelectedLink(undefined)} />
    </>
  );
}
