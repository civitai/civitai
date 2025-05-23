import { ActionIcon, Button, ButtonVariant, Title, useMantineTheme } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { AnnouncementDTO } from '~/server/services/announcement.service';
import {
  dismissAnnouncements,
  useAnnouncementsStore,
} from '~/components/Announcements/announcements.utils';
import clsx from 'clsx';
import { TwCard } from '~/components/TwCard/TwCard';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export function Announcement({
  announcement,
  dismissible,
  moderatorActions,
  className,
  style,
  ...props
}: {
  announcement: AnnouncementDTO;
  dismissible?: boolean;
  moderatorActions?: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  const dismissed = useAnnouncementsStore((state) => state.dismissed);
  const { actions, image } = announcement.metadata || {};
  const theme = useMantineTheme();
  const canDismiss = dismissed.includes(announcement.id)
    ? false
    : dismissible ?? announcement.metadata.dismissible ?? true;

  function handleDismiss() {
    dismissAnnouncements(announcement.id);
  }

  return (
    <TwCard
      className={clsx('items-stretch border', className)}
      direction="row"
      style={{ borderColor: theme.colors[announcement.color][4], ...style }}
      {...props}
    >
      {canDismiss && (
        <LegacyActionIcon
          variant="subtle"
          radius="xl"
          color="red"
          onClick={handleDismiss}
          className="absolute right-2 top-2"
        >
          <IconX size={20} />
        </LegacyActionIcon>
      )}

      {image && (
        <div className="relative min-h-40 w-40 @max-md:hidden">
          <EdgeMedia
            src={image}
            width={200}
            alt="Announcement banner image"
            className="absolute inset-0 size-full object-cover"
          />
        </div>
      )}
      <div className="flex flex-1 flex-col justify-center gap-2 p-3">
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
              <Button
                key={index}
                component={Link}
                href={action.link}
                variant={action.variant ? (action.variant as ButtonVariant) : 'outline'}
                color={action.color ?? announcement.color}
                // onClick={handleDismiss}
                // onMouseUp={(e) => {
                //   if (e.button === 1) {
                //     handleDismiss();
                //   }
                // }}
              >
                {action.linkText}
              </Button>
            ))}
          </div>
        )}
      </div>
    </TwCard>
  );
}
