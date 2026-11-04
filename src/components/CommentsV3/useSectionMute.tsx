import { Menu } from '~/components/MantineOverlays';
import { IconBell, IconBellOff, IconDotsVertical } from '@tabler/icons-react';
import { useState } from 'react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import type { SectionMuteInput } from '~/server/schema/commentv2.schema';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * The whole-section control, which mutes the entity's root thread rather than a conversation under
 * one comment. Only rendered on the top-level composer: on a reply box the enclosing comment's own
 * menu is the right place, and two mute controls a few pixels apart would mean different things.
 */
export function useSectionMute({
  target,
  enabled,
}: {
  target?: SectionMuteInput;
  enabled: boolean;
}) {
  const queryUtils = trpc.useUtils();
  const [opened, setOpened] = useState(false);

  // Fetched on menu open only, so a page of comments costs no extra requests.
  const { data } = trpc.commentv2.getSectionMuted.useQuery(target ?? ({} as SectionMuteInput), {
    enabled: !!target && enabled && opened,
  });

  const toggle = trpc.commentv2.toggleSectionMute.useMutation({
    onSuccess(result) {
      if (!target) return;
      queryUtils.commentv2.getSectionMuted.setData(target, {
        muted: result.muted,
        hasThread: result.hasThread,
      });
      showSuccessNotification({
        // States the action, not the outcome: a sub-thread muted separately keeps suppressing after
        // this (the walk climbs), so promising notifications are back on would be false for part of
        // the discussion.
        message: result.muted
          ? "You won't be notified about new comments here"
          : 'Your mute on this discussion has been removed',
      });
    },
    onError(error) {
      showErrorNotification({
        title: 'Unable to update notifications',
        error: new Error(error.message),
      });
    },
  });

  const control = (
    <Menu position="bottom-end" withinPortal opened={opened} onChange={setOpened}>
      <Menu.Target>
        {/*
          Level with the input, not centred on the two-row composer, which would drop it between
          the rows: 38px is the `md` Avatar of the top-level composer, the only one this renders on.
        */}
        <div className="flex h-[38px] shrink-0 items-center self-start">
          <LegacyActionIcon size="sm" variant="subtle" aria-label="Comment notification settings">
            <IconDotsVertical size={16} />
          </LegacyActionIcon>
        </div>
      </Menu.Target>
      <Menu.Dropdown>
        {/*
          Nothing to mute until the first comment creates the thread. Disabled rather than hidden,
          and it says why: firing the mutation there writes nothing and would report success.
        */}
        <Menu.Item
          disabled={!data || !data.hasThread || toggle.isPending}
          leftSection={
            data?.muted ? (
              <IconBell size={14} stroke={1.5} />
            ) : (
              <IconBellOff size={14} stroke={1.5} />
            )
          }
          onClick={() => target && toggle.mutate(target)}
        >
          {!data
            ? 'Mute this discussion'
            : !data.hasThread
            ? 'No comments to mute yet'
            : data.muted
            ? 'Unmute this discussion'
            : 'Mute this discussion'}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );

  return { control: target ? control : null };
}
