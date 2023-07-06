import {
  Badge,
  Center,
  Group,
  Image,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
  createStyles,
} from '@mantine/core';
import { SpotlightActionProps } from '@mantine/spotlight';
import { IconHash, IconUser } from '@tabler/icons-react';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { Username } from '~/components/User/Username';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';

const actions = {
  models: ModelSpotlightAction,
  users: UserSpotlightAction,
  tags: TagSpotlightAction,
} as const;
type ActionType = keyof typeof actions;

const useStyles = createStyles((theme) => ({
  action: {
    position: 'relative',
    display: 'block',
    width: '100%',
    padding: '10px 12px',
    borderRadius: theme.radius.sm,
  },

  actionHovered: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[1],
  },
}));

export function CustomSpotlightAction({
  action,
  styles,
  classNames,
  hovered,
  onTrigger,
  ...others
}: SpotlightActionProps) {
  const { classes, cx } = useStyles(undefined, { styles, classNames, name: 'Spotlight' });
  const { group, ...actionProps } = action;

  if (!group) return null;

  const ActionItem = actions[group as ActionType];

  return (
    <UnstyledButton
      className={cx(classes.action, { [classes.actionHovered]: hovered })}
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onTrigger}
      {...others}
    >
      <ActionItem {...actionProps} />
    </UnstyledButton>
  );
}

function ModelSpotlightAction({
  title,
  description,
  image,
  type,
  nsfw,
  user,
  tags,
}: SpotlightActionProps['action']) {
  return (
    <Group spacing="md" align="flex-start" noWrap>
      <ImageGuard
        images={[image]}
        render={(image) => (
          <Center
            sx={{
              width: 64,
              height: 64,
              position: 'relative',
              overflow: 'hidden',
              borderRadius: '10px',
            }}
          >
            <ImageGuard.Unsafe>
              <MediaHash {...image} cropFocus="top" />
            </ImageGuard.Unsafe>
            <ImageGuard.Safe>
              <EdgeImage
                src={image.url}
                name={image.name ?? image.id.toString()}
                width={450}
                style={{ minWidth: '100%', minHeight: '100%', objectFit: 'cover' }}
              />
            </ImageGuard.Safe>
          </Center>
        )}
      />
      <Stack spacing={4} sx={{ flex: '1 !important' }}>
        <Text size="md">{title}</Text>
        <Group spacing={8}>
          <UserAvatar size="xs" user={user} withUsername />
          {nsfw && (
            <Badge size="xs" color="red">
              NSFW
            </Badge>
          )}
          <Badge size="xs">{type}</Badge>
        </Group>
        <Text size="xs" color="dimmed" sx={{ flex: 1 }}>
          {description}
        </Text>
      </Stack>
    </Group>
  );
}

function UserSpotlightAction({ title, image, ...user }: SpotlightActionProps['action']) {
  return (
    <Group spacing="md" noWrap>
      {image ? (
        <Image src={image} alt={title} width={32} height={32} radius="xl" />
      ) : (
        <ThemeIcon variant="light" size={32} radius="xl">
          <IconUser size={18} stroke={2.5} />
        </ThemeIcon>
      )}
      <Text size="md" lineClamp={1}>
        <Username {...user} inherit />
      </Text>
    </Group>
  );
}

function TagSpotlightAction({ title, description }: SpotlightActionProps['action']) {
  return (
    <Group spacing="md" noWrap>
      <ThemeIcon size={32} radius="xl" variant="light">
        <IconHash size={18} stroke={2.5} />
      </ThemeIcon>
      <Stack spacing={0} sx={{ flexGrow: 1 }}>
        <Text size="md">{title}</Text>
        <Text size="xs" color="dimmed">
          {description}
        </Text>
      </Stack>
    </Group>
  );
}
