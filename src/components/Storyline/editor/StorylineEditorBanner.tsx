import { ActionIcon, Anchor, Badge, Menu, Text, ThemeIcon } from '@mantine/core';
import { IconBooks, IconDots, IconShieldHalf, IconUnlink } from '@tabler/icons-react';
import clsx from 'clsx';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { storylineCardClass } from '~/components/Storyline/StorylineChips';
import { storylineUrl } from '~/components/Storyline/storyline-routes';
import { getBrowsingLevelLabel } from '~/shared/constants/browsingLevel.constants';

type BannerStoryline = { id: number; title: string };
type DraftRemoval = {
  /** The menu is not drawn without it. */
  onRemove?: () => void;
  removing?: boolean;
};

export type StorylineEditorBannerProps =
  | ({ variant: 'start'; storyline: BannerStoryline } & DraftRemoval)
  | { variant: 'chapter'; storyline: BannerStoryline; chapterNumber: number }
  /** A draft that continues a chapter of the storyline. */
  | ({
      variant: 'continue';
      storyline: BannerStoryline & { maxNsfwLevel: number };
      chapterNumber: number;
    } & DraftRemoval);

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
        {props.variant !== 'chapter' ? (
          <>
            <div className="flex items-center gap-2">
              <Text size="xs" fw={700} c="violet">
                Chapter {props.variant === 'start' ? 1 : props.chapterNumber}
              </Text>
              {props.variant === 'continue' && (
                <Badge
                  variant="light"
                  color="gray"
                  size="xs"
                  radius="xl"
                  leftSection={<IconShieldHalf size={10} />}
                >
                  Up to {getBrowsingLevelLabel(props.storyline.maxNsfwLevel)}
                </Badge>
              )}
            </div>
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
      {props.variant !== 'chapter' && props.onRemove && (
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
