import React from 'react';
import { ActionIcon, Button, Card, Group, Stack, Text, Title, Box } from '@mantine/core';
import { AnnouncementDTO } from '~/server/services/announcement.service';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { ButtonVariant } from '@mantine/core/lib/Button/Button.styles';
import { IconX } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import classes from './AnnouncementHomeBlockAnnouncementItem.module.scss';

const AnnouncementHomeBlockAnnouncementItem = ({ announcement, onAnnouncementDismiss }: Props) => {
  const announcementMetadata = announcement.metadata;
  const { actions, image } = announcementMetadata || {};
  const dismissible = announcementMetadata?.dismissible ?? true;

  return (
    <Card
      radius="md"
      p="lg"
      withBorder
      shadow="sm"
      className={`${classes.card} ${classes.cardBorder}`}
      style={{ borderColor: `var(--mantine-color-${announcement.color}-4)` }}
    >
      {dismissible && (
        <ActionIcon
          variant="subtle"
          radius="xl"
          color="red"
          onClick={() => onAnnouncementDismiss(announcement.id)}
          className={classes.dismissButton}
        >
          <IconX size={20} />
        </ActionIcon>
      )}
      {image && (
        <Box
          className={classes.imageContainer}
          style={{ borderColor: `var(--mantine-color-${announcement.color}-4)` }}
        >
          <EdgeMedia src={image} width={512} alt="Announcement banner image" />
        </Box>
      )}
      <Stack className={classes.stack}>
        <Group spacing="md" noWrap>
          {announcement.emoji && !image && (
            <Card
              className={`${classes.emojiCard} ${classes.emojiCardBorder}`}
              radius="lg"
              p="sm"
              withBorder
              style={{
                borderColor: `var(--mantine-color-${announcement.color}-4)`,
                background: `rgba(var(--mantine-color-${announcement.color}-9-rgb), 0.2)`,
              }}
            >
              <Text size={28} p={0}>
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

        <ContainerGrid mt="auto">
          {actions &&
            actions.map((action, index) => {
              if (action.type === 'button') {
                return (
                  <ContainerGrid.Col key={index} span="auto">
                    <Link legacyBehavior href={action.link} passHref>
                      <Button
                        component="a"
                        className={classes.action}
                        variant={action.variant ? (action.variant as ButtonVariant) : undefined}
                        color={action.color ?? announcement.color}
                      >
                        {action.linkText}
                      </Button>
                    </Link>
                  </ContainerGrid.Col>
                );
              }

              return null;
            })}
        </ContainerGrid>
      </Stack>
    </Card>
  );
};

type Props = {
  announcement: AnnouncementDTO;
  onAnnouncementDismiss: (announcementId: number) => void;
};

export { AnnouncementHomeBlockAnnouncementItem };

