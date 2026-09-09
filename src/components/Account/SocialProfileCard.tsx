import {
  Alert,
  Button,
  Card,
  Center,
  Divider,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { LinkType } from '~/shared/utils/prisma/enums';
import React, { useState } from 'react';

import { SocialLink } from '~/components/Account/SocialLink';
import { SocialLinkModal } from '~/components/Account/SocialLinkModal';
import { SettingsSection } from '~/components/Account/SettingsLayout';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { sortDomainLinks } from '~/utils/domain-link';
import { trpc } from '~/utils/trpc';

export function SocialProfileCard({ flat }: { flat?: boolean } = {}) {
  const user = useCurrentUser();

  const [selectedLink, setSelectedLink] = useState<{
    id?: number;
    type: LinkType;
    url?: string;
  }>();

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

  if (!user) return null;

  const linksFor = (type: LinkType) => (type === LinkType.Social ? data?.social : data?.sponsorship);

  const renderLinks = (type: LinkType) => {
    const links = linksFor(type);
    return (
      <Card withBorder>
        <Card.Section withBorder p="sm">
          <Group justify="space-between">
            <Title order={5}>{type} Links</Title>
            <Button size="compact-sm" onClick={() => setSelectedLink({ type })}>
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

  // A labelled run of rows inside the one section, not a section of its own — social and
  // sponsorship links share the "Creator profile" heading.
  const renderGroup = (type: LinkType, label: string) => {
    const links = linksFor(type);
    return (
      <div className="flex flex-col gap-2">
        <Text size="xs" fw={600} c="dimmed" tt="uppercase" className="tracking-wide">
          {label}
        </Text>
        {isLoading ? (
          <Center p="sm">
            <Loader size="sm" />
          </Center>
        ) : !links?.length ? (
          <Text size="sm" c="dimmed">
            No {label.toLowerCase()} yet.
          </Text>
        ) : (
          <div className="flex flex-col">
            {sortDomainLinks(links).map((link, index) => (
              <React.Fragment key={link.id}>
                <SocialLink link={link} setSelected={setSelectedLink} />
                {index < links.length - 1 && <Divider p={0} my="xs" />}
              </React.Fragment>
            ))}
          </div>
        )}
        <Group justify="flex-end">
          <Button
            variant="default"
            size="compact-sm"
            leftSection={<IconPlus size={14} />}
            onClick={() => setSelectedLink({ type })}
          >
            Add link
          </Button>
        </Group>
      </div>
    );
  };

  return (
    <>
      {flat ? (
        <SettingsSection
          title="Creator profile"
          description="Shown on your public profile."
        >
          {renderGroup(LinkType.Social, 'Social links')}
          {renderGroup(LinkType.Sponsorship, 'Sponsorship links')}
        </SettingsSection>
      ) : (
        <Card withBorder>
          <Stack>
            <Title order={2}>Creator Profile</Title>
            {renderLinks(LinkType.Social)}
            {renderLinks(LinkType.Sponsorship)}
          </Stack>
        </Card>
      )}
      <SocialLinkModal selected={selectedLink} onClose={() => setSelectedLink(undefined)} />
    </>
  );
}
