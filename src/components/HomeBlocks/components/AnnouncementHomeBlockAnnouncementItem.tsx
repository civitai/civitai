import React from 'react';
import { ActionIcon, Button, Card, Group, Stack, Text, Title, Box } from '@mantine/core';
import { AnnouncementDTO } from '~/server/services/announcement.service';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconX } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import classes from './AnnouncementHomeBlock.module.scss';
import clsx from 'clsx';

const AnnouncementHomeBlockAnnouncementItem = ({ announcement, onAnnouncementDismiss }: Props) => {
  const announcementMetadata = announcement.metadata;
  const color = announcement.color || 'blue';
  const { actions, image } = announcementMetadata || {};

  const dismissible = announcementMetadata?.dismissible ?? true;

  return (
    <Card
      radius="md"
      p="lg"
      withBorder
      shadow="sm"
      className={clsx(classes.card, classes[`card-${color}`], { [classes.imageCard]: image })}
    >
      {dismissible && (
        <ActionIcon
          variant="subtle"
          radius="xl"
          color="red"
          onClick={() => onAnnouncementDismiss(announcement.id)}
          style={{
            position: 'absolute',
            top: 'var(--mantine-spacing-xs)',
            right: 'var(--mantine-spacing-xs)',
          }}
        >
          <IconX size={20} />
        </ActionIcon>
      )}
      {image && (
        <Box className={clsx(classes.imageContainer, classes[`imageContainer-${color}`])}>
          <EdgeMedia src={image} width={512} alt="Announcement banner image" />
        </Box>
      )}
      <Stack className={classes.stack}>
        <Group gap="md" wrap="nowrap">
          {announcement.emoji && !image && (
            <Card
              className={clsx(classes.emojiCard, classes[`emojiCard-${color}`])}
              radius="lg"
              p="sm"
              withBorder
            >
              <Text fz={28} p={0}>
                {announcement.emoji}
              </Text>
            </Card>
          )}
          <Title order={3}>{announcement.title}</Title>
        </Group>

        <Text>
          <CustomMarkdown allowedElements={['a']} unwrapDisallowed>
            {announcement.content}
          </CustomMarkdown>
        </Text>

        <ContainerGrid2 className="mt-auto">
          {actions &&
            actions.map((action, index) => {
              if (action.type === 'button') {
                return (
                  <ContainerGrid2.Col key={index} span="auto">
                    <Link legacyBehavior href={action.link} passHref>
                      <Button
                        component="a"
                        className={classes.action}
                        variant={action.variant ?? undefined}
                        color={action.color ?? announcement.color}
                      >
                        {action.linkText}
                      </Button>
                    </Link>
                  </ContainerGrid2.Col>
                );
              }

              return null;
            })}
        </ContainerGrid2>
      </Stack>
    </Card>
  );
};

type Props = {
  announcement: AnnouncementDTO;
  onAnnouncementDismiss: (announcementId: number) => void;
};

export { AnnouncementHomeBlockAnnouncementItem };
