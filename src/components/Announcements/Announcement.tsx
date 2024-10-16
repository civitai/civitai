import { ActionIcon, Button, ButtonVariant, Title, useMantineTheme } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import Link from 'next/link';
import { useAnnouncementsContext } from '~/components/Announcements/AnnouncementsProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { GetAnnouncement } from '~/server/services/announcement.service';

export function Announcement({ announcement }: { announcement: GetAnnouncement }) {
  const { dismissed } = useAnnouncementsContext();
  const { actions, image, dismissible = true } = announcement.metadata || {};
  const theme = useMantineTheme();
  const canDismiss = dismissed.includes(announcement.id) ? false : dismissible;
  const { dismiss } = useAnnouncementsContext();

  return (
    <div
      className="relative flex border card"
      style={{ borderColor: theme.colors[announcement.color][4] }}
    >
      {canDismiss && (
        <ActionIcon
          variant="subtle"
          radius="xl"
          color="red"
          onClick={() => dismiss(announcement.id)}
          className="absolute right-2 top-2"
        >
          <IconX size={20} />
        </ActionIcon>
      )}
      <div className="grid grid-cols-[auto,1fr] @max-md:grid-cols-1">
        {image && (
          <div className="relative aspect-square @max-md:hidden">
            <EdgeMedia
              src={image}
              width={200}
              alt="Announcement banner image"
              className="absolute inset-0"
            />
          </div>
        )}
        <div className="mr-5 flex flex-1 flex-col gap-3 p-3">
          <Title order={3}>{announcement.title}</Title>
          <CustomMarkdown allowedElements={['a']} unwrapDisallowed>
            {announcement.content}
          </CustomMarkdown>
          {actions && (
            <div className="flex gap-2">
              {actions.map((action, index) => (
                <Link key={index} href={action.link} passHref>
                  <Button
                    component="a"
                    variant={action.variant ? (action.variant as ButtonVariant) : undefined}
                    color={action.color ?? announcement.color}
                  >
                    {action.linkText}
                  </Button>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
