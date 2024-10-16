import { ActionIcon, Button, ButtonVariant, Title, useMantineTheme } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import Link from 'next/link';
import { useAnnouncementsContext } from '~/components/Announcements/AnnouncementsProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { AnnouncementDTO } from '~/server/services/announcement.service';
import clsx from 'clsx';

export function Announcement({
  announcement,
  dismissible,
  moderatorActions,
}: {
  announcement: AnnouncementDTO;
  dismissible?: boolean;
  moderatorActions?: React.ReactNode;
}) {
  const { dismissed } = useAnnouncementsContext();
  const { actions, image } = announcement.metadata || {};
  const theme = useMantineTheme();
  const canDismiss = dismissed.includes(announcement.id)
    ? false
    : dismissible ?? announcement.metadata.dismissible;
  const { dismiss } = useAnnouncementsContext();

  return (
    <div
      className="relative flex border card"
      style={{ borderColor: theme.colors[announcement.color][4] }}
    >
      <div className="flex items-stretch">
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

        {image && (
          <div className="relative w-40 @max-md:hidden">
            <EdgeMedia
              src={image}
              width={200}
              alt="Announcement banner image"
              className="absolute inset-0 size-full object-cover"
            />
          </div>
        )}
        <div className="flex flex-1 flex-col gap-2 p-3">
          <div className="flex justify-between gap-2">
            <Title order={4}>{announcement.title}</Title>
            {moderatorActions}
          </div>
          <CustomMarkdown allowedElements={['a']} unwrapDisallowed>
            {announcement.content}
          </CustomMarkdown>
          {actions && (
            <div className="flex gap-2">
              {actions.map((action, index) => (
                <Link key={index} href={action.link} passHref>
                  <Button
                    component="a"
                    variant={action.variant ? (action.variant as ButtonVariant) : 'outline'}
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
