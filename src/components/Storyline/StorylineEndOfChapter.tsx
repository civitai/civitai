import {
  Badge,
  Button,
  CloseButton,
  Loader,
  Progress,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { IconArrowRight, IconPlus } from '@tabler/icons-react';
import clsx from 'clsx';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { StorylineEarlyAccessModal } from '~/components/Storyline/StorylineEarlyAccessModal';
import { openStorylineContinueModal } from '~/components/Storyline/continue/openStorylineContinueModal';
import type { StorylineChild } from '~/components/Storyline/storyline.queries';
import {
  useStorylineChildren,
  useStorylineContinueTerms,
  useStorylineForkShares,
  useStorylineTracking,
} from '~/components/Storyline/storyline.queries';
import {
  getStorylineChapterName,
  getStorylineTombstoneLabel,
} from '~/components/Storyline/storyline-mode.utils';

const rankLabel: Record<StorylineChild['rank'], string | null> = {
  canon: 'Canon',
  endorsed: 'Endorsed',
  community: null,
};

export function openStorylineEarlyAccess({
  chapterId,
  storylineId,
}: {
  chapterId: number;
  storylineId: number;
}) {
  dialogStore.trigger({
    id: 'storyline-early-access',
    component: StorylineEarlyAccessModal,
    props: { chapterId, storylineId },
  });
}

/**
 * The fork point at the end of a chapter. The first child is the main path and gets the big
 * card; the order is the server's (canon, endorsed collaborators, then by readers).
 */
export function StorylineEndOfChapter({
  chapterId,
  storylineId,
  chapterTombstone,
  parentPostId,
  onContinue,
  onClose,
}: {
  chapterId: number;
  storylineId: number;
  chapterTombstone?: Parameters<typeof getStorylineTombstoneLabel>[0] | null;
  onContinue: (child: StorylineChild) => void;
  onClose?: () => void;
  /** The post of the chapter that ends here; absent when it is a tombstone. */
  parentPostId?: number;
}) {
  const { data: children, isLoading } = useStorylineChildren(chapterId);
  const { data: forkShares } = useStorylineForkShares(chapterId);
  const tracking = useStorylineTracking();

  const handleCreate = () => {
    tracking.trackCreateClick({ chapterId });
    openStorylineEarlyAccess({ chapterId, storylineId });
  };

  const [main, ...others] = children ?? [];

  return (
    <div
      className="absolute inset-0 z-20 overflow-y-auto bg-gray-0 p-4 dark:bg-dark-7 @md:p-6"
      data-testid="storyline-end-of-chapter"
    >
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <Text size="sm" c="dimmed">
              {chapterTombstone
                ? getStorylineTombstoneLabel(chapterTombstone)
                : 'End of the chapter you are reading'}
            </Text>
            <Title order={3}>
              {!children?.length && !isLoading
                ? 'The story stops here, for now'
                : 'What happens next?'}
            </Title>
          </div>
          {onClose && <CloseButton onClick={onClose} aria-label="Back to the chapter" />}
        </div>

        {isLoading ? (
          <Loader className="mx-auto" />
        ) : (
          <>
            {forkShares && !forkShares.enough && !!children?.length && (
              <Text size="xs" c="dimmed" data-testid="storyline-shares-pending">
                Not enough readers yet to show where people go ({forkShares.total} of{' '}
                {forkShares.minChoices} choices)
              </Text>
            )}
            {main && (
              <ForkCard
                child={main}
                share={forkShares?.enough ? forkShares.shares[main.chapterId] ?? 0 : undefined}
                onContinue={onContinue}
                big
              />
            )}
            {others.length > 0 && (
              <>
                <Text size="sm" c="dimmed">
                  Other ways readers continued
                </Text>
                <div className="grid grid-cols-1 gap-2 @sm:grid-cols-2">
                  {others.map((child) => (
                    <ForkCard
                      key={child.chapterId}
                      child={child}
                      share={
                        forkShares?.enough ? forkShares.shares[child.chapterId] ?? 0 : undefined
                      }
                      onContinue={onContinue}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        <Button
          size="lg"
          radius="md"
          variant="gradient"
          gradient={{ from: 'violet', to: 'blue', deg: 90 }}
          leftSection={<IconPlus size={20} />}
          onClick={handleCreate}
          data-testid="storyline-create-next"
        >
          Create the next section
        </Button>
        {parentPostId && <StorylineContinueWithPost parentPostId={parentPostId} />}
      </div>
    </div>
  );
}

function ForkCard({
  child,
  share,
  onContinue,
  big,
}: {
  child: StorylineChild;
  share: number | undefined;
  onContinue: (child: StorylineChild) => void;
  big?: boolean;
}) {
  const label = rankLabel[child.rank];
  const title = getStorylineChapterName(child, { withAuthor: true });

  return (
    <UnstyledButton
      onClick={() => onContinue(child)}
      className={clsx(
        'flex items-center gap-3 rounded-lg border border-solid bg-white text-left dark:bg-dark-6',
        big ? 'border-2 border-blue-5 p-4' : 'border-gray-3 p-3 dark:border-dark-4'
      )}
      data-testid="storyline-fork"
      data-rank={child.rank}
      data-chapter-id={child.chapterId}
      data-tombstone={child.tombstone ?? undefined}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Text
            fw={700}
            size={big ? 'lg' : 'sm'}
            lineClamp={2}
            c={child.post ? undefined : 'dimmed'}
          >
            {title}
          </Text>
          {label && (
            <Badge size="sm" variant="outline" color={child.rank === 'canon' ? 'blue' : 'violet'}>
              {label}
            </Badge>
          )}
        </div>
        {child.post?.title && (
          <Text size="xs" c="dimmed">
            Chapter {child.depth + 1}
            {child.post.username ? ` by ${child.post.username}` : ''}
          </Text>
        )}
        {share != null && (
          <div className="mt-1 flex items-center gap-2">
            <Progress value={share * 100} size="sm" className="w-24" />
            <Text size="xs" fw={700}>
              {Math.round(share * 100)}% of readers
            </Text>
          </div>
        )}
      </div>
      {big && (
        <Button component="span" rightSection={<IconArrowRight size={16} />}>
          Read
        </Button>
      )}
    </UnstyledButton>
  );
}

const closedCopy = {
  closed: 'This storyline is not taking continuations right now.',
  collaboratorsOnly: "Only the storyline's collaborators can continue it.",
} as const;

/** Submit a post the reader already made as the next chapter, through the storyline's review. */
export function StorylineContinueWithPost({ parentPostId }: { parentPostId: number }) {
  const terms = useStorylineContinueTerms(parentPostId);
  if (!terms) return null;
  if (!terms.open)
    return terms.closedReason ? (
      <Text size="sm" c="dimmed" ta="center" data-testid="storyline-continue-closed">
        {closedCopy[terms.closedReason]}
      </Text>
    ) : null;

  return (
    <Button
      variant="default"
      radius="md"
      onClick={() => openStorylineContinueModal({ parentPostId })}
      data-testid="storyline-continue-with-post"
    >
      Continue with a post you made · {terms.price > 0 ? `${terms.price} Buzz` : 'Free'}
    </Button>
  );
}
