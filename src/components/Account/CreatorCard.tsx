import { Alert, Button, Card, Divider, Group, Stack, Title } from '@mantine/core';
import { LinkType } from '@prisma/client';
import { useSession } from 'next-auth/react';
import React from 'react';
import { useState } from 'react';
import { SocialLink } from '~/components/Account/SocialLink';
import { SocialLinkModal } from '~/components/Account/SocialLinkModal';
import { trpc } from '~/utils/trpc';

export function CreatorCard() {
  const { data: session } = useSession();

  const [selectedLink, setSelectedLink] = useState<{
    id?: number;
    type: LinkType;
    url?: string;
  }>();

  // const utils = trpc.useContext();
  const { data } = trpc.userLink.getAll.useQuery(
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

  return (
    <>
      <Card withBorder>
        <Stack>
          <Title order={2}>Creator Profile</Title>
          <Card withBorder>
            <Card.Section withBorder p="sm">
              <Group position="apart">
                <Title order={5}>Social Links</Title>
                <Button compact onClick={() => setSelectedLink({ type: LinkType.Social })}>
                  Add Link
                </Button>
              </Group>
            </Card.Section>
            <Card.Section p="sm">
              {!data?.social?.length ? (
                <Alert>You have not added any social links</Alert>
              ) : (
                <div>
                  {data?.social?.map((link, index) => (
                    <React.Fragment key={link.id}>
                      <SocialLink link={link} setSelected={setSelectedLink} />
                      {index < data.social.length - 1 && <Divider p={0} my="xs" />}
                    </React.Fragment>
                  ))}
                </div>
              )}
            </Card.Section>
          </Card>

          <Card withBorder>
            <Card.Section withBorder p="sm">
              <Group position="apart">
                <Title order={5}>Sponsorship Links</Title>
                <Button compact onClick={() => setSelectedLink({ type: LinkType.Sponsorship })}>
                  Add Link
                </Button>
              </Group>
            </Card.Section>
            <Card.Section p="sm">
              {!data?.sponsorship?.length ? (
                <Alert>You have not added any sponsorship links</Alert>
              ) : (
                <div>
                  {data?.sponsorship?.map((link, index) => (
                    <React.Fragment key={link.id}>
                      <SocialLink link={link} setSelected={setSelectedLink} />
                      {index < data.sponsorship.length - 1 && <Divider p={0} my="xs" />}
                    </React.Fragment>
                  ))}
                </div>
              )}
            </Card.Section>
          </Card>
        </Stack>
      </Card>
      <SocialLinkModal selected={selectedLink} onClose={() => setSelectedLink(undefined)} />
    </>
  );
}
