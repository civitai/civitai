import {
  Badge,
  Center,
  Group,
  Highlight,
  Image,
  Rating,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
  createStyles,
} from '@mantine/core';
import { SpotlightActionProps } from '@mantine/spotlight';
import {
  IconBookmark,
  IconBox,
  IconBrush,
  IconDownload,
  IconEye,
  IconHash,
  IconHeart,
  IconMessageCircle2,
  IconMoodSmile,
  IconPhoto,
  IconPhotoOff,
  IconUpload,
  IconUser,
  IconUsers,
} from '@tabler/icons-react';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { Username } from '~/components/User/Username';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { abbreviateNumber } from '~/utils/number-helpers';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';

const actions = {
  models: ModelSpotlightAction,
  users: UserSpotlightAction,
  tags: TagSpotlightAction,
  articles: ArticleSpotlightAction,
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
  query,
  ...others
}: SpotlightActionProps) {
  const { classes, cx } = useStyles(undefined, { styles, classNames, name: 'Spotlight' });
  const { group, ...actionProps } = action;

  const ActionItem = actions[group as ActionType];

  if (!ActionItem) return null;

  return (
    <UnstyledButton
      className={cx(classes.action, { [classes.actionHovered]: hovered })}
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onTrigger}
      {...others}
    >
      <ActionItem {...actionProps} query={query} />
    </UnstyledButton>
  );
}

function ModelSpotlightAction({
  query,
  title,
  image,
  type,
  nsfw,
  user,
  metrics,
  category,
  modelVersion,
}: SpotlightActionProps['action'] & { query: string }) {
  const features = useFeatureFlags();

  return (
    <Group spacing="md" align="flex-start" noWrap>
      <Center
        sx={{
          width: 64,
          height: 64,
          position: 'relative',
          overflow: 'hidden',
          borderRadius: '10px',
        }}
      >
        {image ? (
          nsfw || image.nsfw !== 'None' ? (
            <MediaHash {...image} cropFocus="top" />
          ) : (
            <EdgeImage
              src={image.url}
              name={image.name ?? image.id.toString()}
              width={450}
              style={{
                minWidth: '100%',
                minHeight: '100%',
                objectFit: 'cover',
                position: 'absolute',
                top: 0,
                left: 0,
              }}
            />
          )
        ) : (
          <ThemeIcon variant="light" size={64} radius={0}>
            <IconPhotoOff size={32} />
          </ThemeIcon>
        )}
      </Center>
      {/* <ImageGuard
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
                style={{
                  minWidth: '100%',
                  minHeight: '100%',
                  objectFit: 'cover',
                  position: 'absolute',
                  top: 0,
                  left: 0,
                }}
              />
            </ImageGuard.Safe>
          </Center>
        )}
      /> */}
      <Stack spacing={4} sx={{ flex: '1 !important' }}>
        <Group spacing={8}>
          <Highlight size="md" highlight={query.split(' ')}>
            {title}
          </Highlight>
          {features.imageGeneration && !!modelVersion.modelVersionGenerationCoverage?.workers && (
            <ThemeIcon color="green" variant="filled" radius="xl" size="sm">
              <IconBrush size={12} stroke={2.5} />
            </ThemeIcon>
          )}
        </Group>
        <Group spacing={8}>
          {user.id !== -1 && <UserAvatar size="xs" user={user} withUsername />}
          {nsfw && (
            <Badge size="xs" color="red">
              NSFW
            </Badge>
          )}
          <Badge size="xs">{type}</Badge>
          {category && <Badge size="xs">{category.tag.name}</Badge>}
        </Group>
        <Group spacing={4}>
          <IconBadge
            color="dark"
            size="xs"
            // @ts-ignore: ignoring because size doesn't allow number
            icon={<Rating value={metrics.rating} size={12} readOnly />}
          >
            {abbreviateNumber(metrics.ratingCount)}
          </IconBadge>
          <IconBadge color="dark" size="xs" icon={<IconHeart size={12} stroke={2.5} />}>
            {abbreviateNumber(metrics.favoriteCount)}
          </IconBadge>
          <IconBadge color="dark" size="xs" icon={<IconMessageCircle2 size={12} stroke={2.5} />}>
            {abbreviateNumber(metrics.commentCount)}
          </IconBadge>
          <IconBadge color="dark" size="xs" icon={<IconDownload size={12} stroke={2.5} />}>
            {abbreviateNumber(metrics.downloadCount)}
          </IconBadge>
        </Group>
      </Stack>
    </Group>
  );
}

function UserSpotlightAction({
  query,
  title,
  image,
  stats,
  ...user
}: SpotlightActionProps['action'] & { query: string }) {
  return (
    <Group spacing="md" noWrap>
      {image ? (
        <Image
          src={getEdgeUrl(image, { width: 96 })}
          alt={title}
          width={32}
          height={32}
          radius="xl"
        />
      ) : (
        <ThemeIcon variant="light" size={32} radius="xl">
          <IconUser size={18} stroke={2.5} />
        </ThemeIcon>
      )}
      <Stack spacing={4}>
        <Text size="md" lineClamp={1}>
          <Username {...user} inherit />
        </Text>
        {stats && (
          <Group spacing={4}>
            <IconBadge
              color="dark"
              size="xs"
              // @ts-ignore: ignoring because size doesn't allow number
              icon={<Rating value={stats.ratingAllTime} size={12} readOnly />}
            >
              {abbreviateNumber(stats.ratingCountAllTime)}
            </IconBadge>
            <IconBadge color="dark" size="xs" icon={<IconUpload size={12} stroke={2.5} />}>
              {abbreviateNumber(stats.uploadCountAllTime)}
            </IconBadge>
            <IconBadge color="dark" size="xs" icon={<IconUsers size={12} stroke={2.5} />}>
              {abbreviateNumber(stats.followerCountAllTime)}
            </IconBadge>
            <IconBadge color="dark" size="xs" icon={<IconHeart size={12} stroke={2.5} />}>
              {abbreviateNumber(stats.favoriteCountAllTime)}
            </IconBadge>
            <IconBadge color="dark" size="xs" icon={<IconDownload size={16} />}>
              {abbreviateNumber(stats.downloadCountAllTime)}
            </IconBadge>
          </Group>
        )}
      </Stack>
    </Group>
  );
}

function TagSpotlightAction({
  query,
  title,
  metrics,
}: SpotlightActionProps['action'] & { query: string }) {
  return (
    <Group spacing="md" noWrap>
      <ThemeIcon size={32} radius="xl" variant="light">
        <IconHash size={18} stroke={2.5} />
      </ThemeIcon>
      <Stack spacing={0} sx={{ flexGrow: 1 }}>
        <Highlight highlight={query.split(' ')} size="md">
          {title}
        </Highlight>
        <Group spacing={4}>
          <IconBadge size="xs" color="dark" icon={<IconBox size={12} stroke={2.5} />}>
            {abbreviateNumber(metrics.modelCount)} Models
          </IconBadge>
          <IconBadge size="xs" color="dark" icon={<IconPhoto size={12} stroke={2.5} />}>
            {abbreviateNumber(metrics.imageCount)} Images
          </IconBadge>
        </Group>
      </Stack>
    </Group>
  );
}

function ArticleSpotlightAction({
  query,
  title,
  image,
  user,
  nsfw,
  tags,
  metrics,
}: SpotlightActionProps['action'] & { query: string }) {
  return (
    <Group spacing="md" noWrap>
      <Center
        sx={{
          width: 64,
          height: 64,
          position: 'relative',
          overflow: 'hidden',
          borderRadius: '10px',
        }}
      >
        <EdgeImage
          src={image}
          width={450}
          style={{ minWidth: '100%', minHeight: '100%', objectFit: 'cover' }}
        />
      </Center>
      <Stack spacing={4} sx={{ flex: '1 !important' }}>
        <Highlight size="md" highlight={query.split(' ')}>
          {title}
        </Highlight>
        <Group spacing={4}>
          <UserAvatar size="xs" user={user} withUsername />
          {nsfw && (
            <Badge size="xs" color="red">
              NSFW
            </Badge>
          )}
          {tags?.map((tag: string) => (
            <Badge key={tag} size="xs">
              {tag}
            </Badge>
          ))}
        </Group>
        <Group spacing={4}>
          <IconBadge icon={<IconBookmark size={12} stroke={2.5} />} color="dark" size="xs">
            {abbreviateNumber(metrics.favoriteCount)}
          </IconBadge>
          <IconBadge icon={<IconMoodSmile size={12} stroke={2.5} />} color="dark" size="xs">
            {abbreviateNumber(metrics.reactionCount)}
          </IconBadge>
          <IconBadge icon={<IconMessageCircle2 size={12} stroke={2.5} />} color="dark" size="xs">
            {abbreviateNumber(metrics.commentCount)}
          </IconBadge>
          <IconBadge icon={<IconEye size={12} stroke={2.5} />} color="dark" size="xs">
            {abbreviateNumber(metrics.viewCount)}
          </IconBadge>
        </Group>
      </Stack>
    </Group>
  );
}
