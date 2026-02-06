import { AspectRatio, Badge, Checkbox } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { memo, useCallback, useMemo } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover2 } from '~/components/Image/Meta/ImageMetaPopover';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import type { ImageGetInfinite } from '~/types/router';
import type { ChallengeDetail } from '~/server/schema/challenge.schema';
import clsx from 'clsx';

type EligibilityStatus = {
  eligible: boolean;
  reasons: string[];
};

type Props = {
  image: ImageGetInfinite[number];
  challenge: Pick<ChallengeDetail, 'allowedNsfwLevel' | 'startsAt' | 'modelVersionIds'>;
  selected: boolean;
  onToggle: (imageId: number) => void;
};

/**
 * Client-side eligibility checks for challenge entries.
 * Validates NSFW level, recency, and model version requirements.
 */
function getEligibility(
  image: ImageGetInfinite[number],
  challenge: Pick<ChallengeDetail, 'allowedNsfwLevel' | 'startsAt' | 'modelVersionIds'>
): EligibilityStatus {
  const reasons: string[] = [];

  // Check NSFW level
  if ((image.nsfwLevel & challenge.allowedNsfwLevel) === 0) {
    reasons.push('NSFW restricted');
  }

  // Check recency
  if (new Date(image.createdAt) < new Date(challenge.startsAt)) {
    reasons.push('Created before challenge');
  }

  // Check model version requirement
  if (challenge.modelVersionIds.length > 0) {
    const imageVersionIds = image.modelVersionIds ?? [];
    const hasEligibleModel = imageVersionIds.some((vid) =>
      challenge.modelVersionIds.includes(vid)
    );
    if (!hasEligibleModel) {
      reasons.push('Wrong model');
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

function ChallengeSelectableImageCard({ image, challenge, selected, onToggle }: Props) {
  const eligibility = useMemo(
    () => getEligibility(image, challenge),
    [image, challenge]
  );

  const handleClick = useCallback(() => {
    if (!eligibility.eligible) return;
    onToggle(image.id);
  }, [eligibility.eligible, onToggle, image.id]);

  return (
    <MasonryCard
      shadow="sm"
      onClick={handleClick}
      className={clsx('cursor-pointer', {
        'opacity-60': selected,
        'cursor-not-allowed opacity-40 grayscale': !eligibility.eligible,
      })}
      withBorder
    >
      <div className="relative">
        <ImageGuard2 image={image}>
          {(safe) => (
            <>
              <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
              {!safe ? (
                <AspectRatio ratio={(image?.width ?? 1) / (image?.height ?? 1)}>
                  <MediaHash {...image} />
                </AspectRatio>
              ) : (
                <EdgeMedia
                  src={image.url}
                  name={image.name ?? image.id.toString()}
                  alt={image.name ?? undefined}
                  type={image.type}
                  width={450}
                  placeholder="empty"
                  style={{ width: '100%' }}
                />
              )}
            </>
          )}
        </ImageGuard2>

        {eligibility.eligible ? (
          <Checkbox size="lg" checked={selected} className="absolute right-1.5 top-1.5" readOnly />
        ) : (
          <Badge
            color="red"
            variant="filled"
            size="sm"
            className="absolute right-1.5 top-1.5 max-w-[calc(100%-12px)]"
          >
            {eligibility.reasons[0] ?? 'Ineligible'}
          </Badge>
        )}

        {image.hasMeta && (
          <div className="absolute bottom-0.5 right-0.5 z-10">
            <ImageMetaPopover2 imageId={image.id} type={image.type}>
              <LegacyActionIcon component="div" variant="light" color="dark" size="lg">
                <IconInfoCircle color="white" strokeWidth={2.5} size={26} />
              </LegacyActionIcon>
            </ImageMetaPopover2>
          </div>
        )}
      </div>
    </MasonryCard>
  );
}

export const ChallengeSelectableImageCardMemoized = memo(ChallengeSelectableImageCard);
