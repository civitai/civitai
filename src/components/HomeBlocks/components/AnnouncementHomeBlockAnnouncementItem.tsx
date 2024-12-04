import React from 'react';
import {
  ActionIcon,
  Button,
  Card,
  createStyles,
  Group,
  Stack,
  Text,
  Title,
  Box,
} from '@mantine/core';
import { AnnouncementDTO } from '~/server/services/announcement.service';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { ButtonVariant } from '@mantine/core/lib/Button/Button.styles';
import { IconX } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';

const useStyles = createStyles((theme, { color }: { color: string }, getRef) => ({
  card: {
    display: 'flex',
    minHeight: '100%',
    borderColor: theme.colors[color][4],
  },
  emojiCard: {
    borderColor: theme.colors[color][4],
    background: theme.fn.rgba(theme.colors[color][9], 0.2),
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 62,
    height: 62,
  },
  imageCard: {
    [containerQuery.smallerThan('md')]: {
      padding: 0,
      display: 'block',
      [`& .${getRef('stack')}`]: {
        padding: theme.spacing.lg,
      },
    },
  },
  imageContainer: {
    width: 200,
    margin: -theme.spacing.lg,
    marginRight: theme.spacing.lg,
    borderRight: `1px solid ${theme.colors[color][4]}`,

    [containerQuery.smallerThan('xl')]: {
      width: 120,
    },
    [containerQuery.smallerThan('md')]: {
      height: 120,
      width: '100%',
      margin: 0,
      borderBottom: `1px solid ${theme.colors[color][4]}`,
      borderRight: 'none',
    },

    img: {
      objectFit: 'cover',
      width: '100%',
      height: '100%',
    },
  },
  stack: {
    ref: getRef('stack'),
    flex: '1',
  },
  action: {
    [containerQuery.smallerThan('sm')]: {
      display: 'flex',
      flexGrow: 1,
      justifyContent: 'center',
    },
  },
}));

const AnnouncementHomeBlockAnnouncementItem = ({ announcement, onAnnouncementDismiss }: Props) => {
  const { classes, cx } = useStyles({ color: announcement.color });
  const announcementMetadata = announcement.metadata;
  const { actions, image } = announcementMetadata || {};

  const dismissible = announcementMetadata?.dismissible ?? true;

  return (
    <Card
      radius="md"
      p="lg"
      withBorder
      shadow="sm"
      className={cx(classes.card, { [classes.imageCard]: image })}
    >
      {dismissible && (
        <ActionIcon
          variant="subtle"
          radius="xl"
          color="red"
          onClick={() => onAnnouncementDismiss(announcement.id)}
          sx={(theme) => ({
            position: 'absolute',
            top: theme.spacing.xs,
            right: theme.spacing.xs,
          })}
        >
          <IconX size={20} />
        </ActionIcon>
      )}
      {image && (
        <Box className={classes.imageContainer}>
          <EdgeMedia src={image} width={512} alt="Announcement banner image" />
        </Box>
      )}
      <Stack className={classes.stack}>
        <Group spacing="md" noWrap>
          {announcement.emoji && !image && (
            <Card className={classes.emojiCard} radius="lg" p="sm" withBorder>
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
