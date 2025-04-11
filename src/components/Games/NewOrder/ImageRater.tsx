import { Button, Kbd, ActionIcon, Tooltip, Text } from '@mantine/core';
import { IconArrowBackUp, IconFlag, IconVolumeOff, IconVolume } from '@tabler/icons-react';
import { useState } from 'react';
import { damnedReasonOptions, ratingOptions } from '~/components/Games/KnightsNewOrder.utils';
import { useIsMobile } from '~/hooks/useIsMobile';
import { NewOrderDamnedReason, NsfwLevel } from '~/server/common/enums';
import { browsingLevelDescriptions } from '~/shared/constants/browsingLevel.constants';
import { getDisplayName } from '~/utils/string-helpers';

export function ImageRater({ muted, onRatingClick, onVolumeClick }: Props) {
  const mobile = useIsMobile({ breakpoint: 'md' });

  const [damnedReason, setDamnedReason] = useState<{ open: boolean; reason: string | null }>({
    open: false,
    reason: null,
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-nowrap gap-2">
        {damnedReason.open && (
          <Tooltip label="Cancel">
            <Button
              variant="default"
              className="md:h-full"
              onClick={() => setDamnedReason({ open: false, reason: null })}
            >
              <IconArrowBackUp />
            </Button>
          </Tooltip>
        )}
        <Button.Group orientation={damnedReason.open ? 'vertical' : 'horizontal'}>
          {damnedReason.open
            ? damnedReasonOptions.map((reason) => {
                const damnedReason = NewOrderDamnedReason[reason];

                return (
                  <Button
                    key={reason}
                    classNames={{
                      root: 'md:h-auto md:max-w-[150px]',
                      label: 'whitespace-normal leading-normal text-center',
                    }}
                    variant="default"
                    onClick={() => onRatingClick({ rating: NsfwLevel.Blocked, damnedReason })}
                    fullWidth
                  >
                    {getDisplayName(damnedReason)}
                  </Button>
                );
              })
            : ratingOptions.map((rating) => {
                const level = NsfwLevel[rating];
                const isBlocked = level === 'Blocked';

                return (
                  <Tooltip
                    key={rating}
                    label={browsingLevelDescriptions[rating]}
                    position="top"
                    openDelay={1000}
                    maw={350}
                    withArrow
                    multiline
                  >
                    <Button
                      key={rating}
                      variant={isBlocked ? 'filled' : 'default'}
                      color={isBlocked ? 'red' : undefined}
                      onClick={() =>
                        isBlocked
                          ? setDamnedReason({ open: true, reason: null })
                          : onRatingClick({ rating })
                      }
                    >
                      {isBlocked ? <IconFlag size={18} /> : level}
                    </Button>
                  </Tooltip>
                );
              })}
        </Button.Group>
      </div>
      <div className="flex w-full justify-between gap-2">
        <Text size="xs">
          Use the numbers <Kbd>1-6</Kbd> to rate.
          {damnedReason.open && (
            <>
              {' '}
              <Kbd>Esc</Kbd> to cancel
            </>
          )}
        </Text>
        <ActionIcon size="sm" variant="transparent" onClick={onVolumeClick}>
          {muted ? <IconVolumeOff size={16} /> : <IconVolume size={16} />}
        </ActionIcon>
      </div>
    </div>
  );
}

type Props = {
  onRatingClick: (data: { rating: NsfwLevel; damnedReason?: NewOrderDamnedReason }) => void;
  onVolumeClick: () => void;
  muted?: boolean;
};
