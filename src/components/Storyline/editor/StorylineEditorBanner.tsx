import { ActionIcon, Anchor, Menu, Text, ThemeIcon } from '@mantine/core';
import { IconBooks, IconDots, IconUnlink } from '@tabler/icons-react';
import clsx from 'clsx';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { storylineCardClass } from '~/components/Storyline/StorylineChips';
import { storylineUrl } from '~/components/Storyline/storyline-routes';

type BannerStoryline = { id: number; title: string };

export type StorylineEditorBannerProps =
  | {
      variant: 'start';
      storyline: BannerStoryline;
      /** Draft only. The menu is not drawn without it. */
      onRemove?: () => void;
      removing?: boolean;
    }
  | { variant: 'chapter'; storyline: BannerStoryline; chapterNumber: number };

/** What the post editor says about the storyline its post belongs to. */
export function StorylineEditorBanner(props: StorylineEditorBannerProps) {
  const { storyline } = props;
  return (
    <section
      aria-label="Storyline"
      className={clsx(storylineCardClass, 'flex items-center gap-3 p-3')}
    >
      <ThemeIcon variant="light" color="violet" radius="xl" className="shrink-0">
        <IconBooks size={16} aria-hidden />
      </ThemeIcon>
      <div className="min-w-0 flex-1">
        {props.variant === 'start' ? (
          <>
            <Text size="xs" fw={700} c="violet">
              Chapter 1
            </Text>
            <Anchor
              component={Link}
              href={storylineUrl(storyline.id)}
              fw={700}
              c="inherit"
              className="block truncate"
            >
              {storyline.title}
            </Anchor>
          </>
        ) : (
          <Text size="sm">
            Chapter {props.chapterNumber} of{' '}
            <Anchor component={Link} href={storylineUrl(storyline.id)} fw={700}>
              {storyline.title}
            </Anchor>
          </Text>
        )}
      </div>
      {props.variant === 'start' && props.onRemove && (
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon variant="subtle" color="gray" aria-label="Storyline options">
              <IconDots size={18} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<IconUnlink size={14} />}
              disabled={props.removing}
              onClick={props.onRemove}
            >
              Remove from storyline
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      )}
    </section>
  );
}
