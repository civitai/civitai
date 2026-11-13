import { Badge, Button, Container, Text, Title } from '@mantine/core';
import { IconArrowLeft, IconSwords, IconUsers } from '@tabler/icons-react';
import clsx from 'clsx';
import Linkify from 'linkify-react';
import type { Opts } from 'linkifyjs';
import Link from 'next/link';
import { Fragment, useMemo } from 'react';
import { CrucibleContextMenu } from '~/components/Crucible/CrucibleContextMenu';
import { CrucibleFollowToggle } from '~/components/Crucible/CrucibleFollowToggle';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CrucibleTimer } from '~/components/Crucible/CrucibleTimer';
import { Username } from '~/components/User/Username';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { Currency, CrucibleStatus } from '~/shared/utils/prisma/enums';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { numberWithCommas } from '~/utils/number-helpers';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { CrucibleContentBadges } from '~/components/Crucible/CrucibleContentBadges';
import { CrucibleUserLink } from '~/components/Crucible/CrucibleUserLink';
import { OwnerRatingControls } from '~/components/RatingReview/OwnerRatingControls';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useCurrentDomainHosts } from '~/hooks/useCurrentDomainHref';
import { isSameSitePath, toOwnRootRelative } from '~/utils/current-domain-href';
import {
  CRUCIBLE_NO_DESCRIPTION,
  getCrucibleStatusBadge,
  getCrucibleTotalPrizePool,
} from '~/utils/crucible-helpers';
import { Flags } from '~/shared/utils/flags';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

type CrucibleHeaderImage = {
  id: number;
  url: string;
  name: string | null;
  nsfwLevel: number;
  width: number | null;
  height: number | null;
};

const linkClassName = 'text-blue-6 underline dark:text-blue-4';

// Links to our own sites render as root-relative paths, so a civitai.red reader stays on .red.
// Elsewhere a protocol is required: bare third-party hosts, emails and mailto: stay text.
// Credentials in the URL are refused.
const descriptionLinkOptions = (ownHosts: readonly string[]): Opts => {
  const sameSite = (href: string) => isSameSitePath(toOwnRootRelative(href, ownHosts));
  return {
    className: linkClassName,
    formatHref: (href) => toOwnRootRelative(href, ownHosts),
    // Linkify omits a falsy attribute.
    target: (href) => (sameSite(href) ? '' : '_blank'),
    rel: (href) => (sameSite(href) ? '' : 'nofollow ugc noopener noreferrer'),
    validate: {
      email: () => false,
      url: (value) => {
        const hasScheme = /^https?:\/\//i.test(value);
        try {
          const url = new URL(hasScheme ? value : `https://${value}`);
          if (url.username || url.password) return false;
          if (hasScheme) return true;
          // A bare mention of our own homepage stays text: linked, it would leave this site.
          return ownHosts.includes(url.host.toLowerCase()) && url.pathname !== '/';
        } catch {
          return false;
        }
      },
    },
  };
};

// A path that starts the text or follows whitespace or an opening bracket, so "and/or" is not one.
// "//host" and "/\host" are excluded here and again by isSameSitePath: browsers treat both as
// another host. So is "/<tab>/host": a browser strips the tab and reads "//host".
const ROOT_PATH = /(^|(?<!\/)[\s([{])(\/[^\s/\\]\S*)/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

function CrucibleDescription({ text }: { text: string }) {
  const { ownHosts } = useCurrentDomainHosts();
  const options = useMemo(() => descriptionLinkOptions(ownHosts), [ownHosts]);

  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(ROOT_PATH)) {
    const path = match[2].replace(TRAILING_PUNCTUATION, '');
    if (!isSameSitePath(path)) continue;
    const start = match.index + match[1].length;
    parts.push(text.slice(last, start));
    parts.push(
      <a key={start} href={path} className={linkClassName}>
        {path}
      </a>
    );
    last = start + path.length;
  }
  parts.push(text.slice(last));

  return (
    <>
      {parts.map((part, i) =>
        typeof part === 'string' ? (
          <Linkify key={i} options={options}>
            {part}
          </Linkify>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        )
      )}
    </>
  );
}

export type CrucibleHeaderData = {
  id: number;
  name: string;
  description: string | null;
  status: CrucibleStatus;
  nsfwLevel: number;
  entryFee: number;
  seededPrizePool: number;
  buzzType: BuzzSpendType;
  startAt: Date | null;
  endAt: Date | null;
  contentType: MediaType;
  user: UserWithCosmetics;
  image: CrucibleHeaderImage | null;
  heroImage: CrucibleHeaderImage | null;
  _count: {
    entries: number;
  };
  paidEntryCount: number;
  entrantCount: number;
};

type CrucibleHeaderProps = {
  crucible: CrucibleHeaderData;
  /** The entries the viewer can see listed; the raw `_count.entries` also counts hidden ones. */
  entryCount?: number;
  className?: string;
};

export function CrucibleHeader({
  crucible,
  entryCount: listedCount,
  className,
}: CrucibleHeaderProps) {
  const {
    name,
    description,
    status,
    nsfwLevel,
    entryFee,
    seededPrizePool,
    buzzType,
    startAt,
    endAt,
    contentType,
    user,
    image,
    heroImage,
    _count,
    paidEntryCount,
    entrantCount,
  } = crucible;
  const entryCount = listedCount ?? _count.entries ?? 0;
  const prizePool = getCrucibleTotalPrizePool({ entryFee, paidEntryCount, seededPrizePool });
  const browsingLevel = useBrowsingLevelDebounced();
  const currentUser = useCurrentUser();
  // Drawn without an ImageGuard, so it only shows once scanned and inside the viewer's level.
  const backgroundImage =
    [heroImage, image].find(
      (candidate) => candidate && Flags.intersects(candidate.nsfwLevel, browsingLevel)
    ) ?? null;

  const statusBadge = getCrucibleStatusBadge(status, { startAt, endAt });

  return (
    <div
      className={clsx('relative flex min-h-[350px] overflow-hidden sm:min-h-[500px]', className)}
      style={{
        background: !backgroundImage
          ? 'linear-gradient(135deg, #1a1b1e 0%, #25262b 100%)'
          : undefined,
      }}
    >
      {backgroundImage && (
        <div className="absolute inset-0 overflow-hidden">
          <EdgeMedia
            src={backgroundImage.url}
            name={backgroundImage.name}
            type="image"
            width={450}
            className="size-full scale-110 object-cover opacity-40 blur-2xl"
            // EdgeImage caps maxWidth at the requested width, which left a bare strip on wide screens.
            style={{ maxWidth: 'none' }}
          />
          <EdgeMedia
            src={backgroundImage.url}
            name={backgroundImage.name}
            type="image"
            width={1600}
            className="absolute inset-0 size-full object-contain opacity-70"
            style={{ maxWidth: 'none' }}
          />
        </div>
      )}

      <div
        className="absolute inset-0"
        style={{
          background: 'linear-gradient(to bottom, rgba(26,27,30,0.1) 0%, rgba(26,27,30,0.8) 100%)',
        }}
      />

      <Container
        size="xl"
        className="relative z-10 flex w-full flex-col justify-between gap-6 pt-4"
      >
        <div className="flex items-center justify-between">
          {/* Not `NavigateBack`: history here is usually the judge page, which links back to this one. */}
          <Button
            component={Link}
            href="/crucibles"
            variant="light"
            color="gray"
            size="compact-sm"
            leftSection={<IconArrowLeft size={16} />}
          >
            Back
          </Button>
          <div className="flex items-center gap-2">
            <CrucibleFollowToggle crucible={{ id: crucible.id, status: crucible.status }} />
            <CrucibleContextMenu
              crucible={{ id: crucible.id, userId: crucible.user.id }}
              position="bottom-end"
              withCommentsLock
            />
          </div>
        </div>

        <div
          className="mb-8 max-w-2xl self-start rounded-xl border border-white/10 p-5 sm:p-8"
          style={{
            background: 'rgba(37, 38, 43, 0.95)',
            backdropFilter: 'blur(10px)',
          }}
        >
          <div className="mb-3">
            <Badge
              color={statusBadge.color}
              variant="filled"
              radius="xl"
              size="md"
              fw={600}
              tt="uppercase"
            >
              {statusBadge.label}
            </Badge>
          </div>

          <Title order={1} className="mb-3 text-white [overflow-wrap:anywhere]" fw={700} size="h2">
            {name}
          </Title>

          {description ? (
            // Spoiler draws "Show More" in its bottom margin; a margin here would collapse into it.
            <div className="pb-4">
              <ContentClamp maxHeight={72}>
                <Text
                  size="sm"
                  c="dimmed"
                  lh={1.6}
                  className="[overflow-wrap:anywhere]"
                  data-testid="crucible-description"
                >
                  <CrucibleDescription text={description} />
                </Text>
              </ContentClamp>
            </div>
          ) : (
            <Text size="sm" c="dimmed" fs="italic" pb="md">
              {CRUCIBLE_NO_DESCRIPTION}
            </Text>
          )}

          <CrucibleUserLink user={user}>
            <UserAvatar user={user} avatarSize={40} size="lg" withHoverCard={false} />
            <div className="flex flex-col">
              <Username
                username={user.username}
                deletedAt={user.deletedAt}
                cosmetics={user.cosmetics}
                size="sm"
              />
              {!user.deletedAt && user.username && (
                <Text size="xs" c="dimmed" lh={1.3}>
                  @{user.username}
                </Text>
              )}
            </div>
          </CrucibleUserLink>

          <div className="mt-4">
            <OwnerRatingControls
              entityType="Crucible"
              entityId={crucible.id}
              isOwner={currentUser?.id === user.id}
            />
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-white/10 pt-4">
            <div className="flex items-center gap-2">
              <CurrencyBadge
                currency={Currency.BUZZ}
                type={buzzType}
                unitAmount={prizePool}
                variant="transparent"
                size="lg"
                fw={700}
              />
            </div>

            <div className="flex items-center gap-2">
              <IconSwords size={18} className="text-dimmed" />
              <Text size="sm" fw={600} c="white">
                {numberWithCommas(entryCount)} {entryCount === 1 ? 'entry' : 'entries'}
              </Text>
            </div>

            <div className="flex items-center gap-2">
              <IconUsers size={18} className="text-dimmed" />
              <Text size="sm" fw={600} c="white">
                {numberWithCommas(entrantCount)} {entrantCount === 1 ? 'entrant' : 'entrants'}
              </Text>
            </div>

            {status === CrucibleStatus.Active && endAt && <CrucibleTimer endAt={endAt} />}

            <CrucibleContentBadges contentType={contentType} nsfwLevel={nsfwLevel} />
          </div>
        </div>
      </Container>
    </div>
  );
}
