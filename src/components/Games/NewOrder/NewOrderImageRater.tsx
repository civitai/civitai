import { Button, Kbd, ActionIcon, Tooltip, Text, Modal } from '@mantine/core';
import { HotkeyItem, useHotkeys } from '@mantine/hooks';
import { IconArrowBackUp, IconFlag, IconVolumeOff, IconVolume } from '@tabler/icons-react';
import { useState } from 'react';
import { damnedReasonOptions, ratingOptions } from '~/components/Games/KnightsNewOrder.utils';
import { useIsMobile } from '~/hooks/useIsMobile';
import { NewOrderDamnedReason, NsfwLevel } from '~/server/common/enums';
import { browsingLevelDescriptions } from '~/shared/constants/browsingLevel.constants';
import { getDisplayName } from '~/utils/string-helpers';

export function NewOrderImageRater({ muted, onRatingClick, onVolumeClick }: Props) {
  const mobile = useIsMobile({ breakpoint: 'md' });

  const [showReasons, setShowReasons] = useState(false);

  const hotKeys: HotkeyItem[] = showReasons
    ? [
        [
          '1',
          () =>
            onRatingClick({
              rating: NsfwLevel.Blocked,
              damnedReason: NewOrderDamnedReason.InappropriateMinors,
            }),
        ],
        [
          '2',
          () =>
            onRatingClick({
              rating: NsfwLevel.Blocked,
              damnedReason: NewOrderDamnedReason.RealisticMinors,
            }),
        ],
        [
          '3',
          () =>
            onRatingClick({
              rating: NsfwLevel.Blocked,
              damnedReason: NewOrderDamnedReason.InappropriateRealPerson,
            }),
        ],
        [
          '4',
          () =>
            onRatingClick({
              rating: NsfwLevel.Blocked,
              damnedReason: NewOrderDamnedReason.Bestiality,
            }),
        ],
        [
          '5',
          () =>
            onRatingClick({
              rating: NsfwLevel.Blocked,
              damnedReason: NewOrderDamnedReason.GraphicViolence,
            }),
        ],
      ]
    : [
        ['1', () => onRatingClick({ rating: NsfwLevel.PG })],
        ['2', () => onRatingClick({ rating: NsfwLevel.PG13 })],
        ['3', () => onRatingClick({ rating: NsfwLevel.R })],
        ['4', () => onRatingClick({ rating: NsfwLevel.X })],
        ['5', () => onRatingClick({ rating: NsfwLevel.XXX })],
        ['6', () => setShowReasons(true)],
      ];

  useHotkeys([['m', () => onVolumeClick()], ['Escape', () => setShowReasons(false)], ...hotKeys]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-nowrap gap-2">
        {showReasons ? (
          mobile ? (
            <Modal
              title="Select Block Reason"
              onClose={() => setShowReasons(false)}
              opened={showReasons}
              centered
            >
              <DamnedReasonOptions
                onClick={(damnedReason) =>
                  onRatingClick({ rating: NsfwLevel.Blocked, damnedReason })
                }
                onClose={() => setShowReasons(false)}
                mobile
              />
            </Modal>
          ) : (
            <DamnedReasonOptions
              onClick={(damnedReason) => onRatingClick({ rating: NsfwLevel.Blocked, damnedReason })}
              onClose={() => setShowReasons(false)}
            />
          )
        ) : (
          <Button.Group>
            {ratingOptions.map((rating) => {
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
                    onClick={() => (isBlocked ? setShowReasons(true) : onRatingClick({ rating }))}
                  >
                    {isBlocked ? <IconFlag size={18} /> : level}
                  </Button>
                </Tooltip>
              );
            })}
          </Button.Group>
        )}
      </div>
      <div className="flex w-full justify-between gap-2">
        <Text className="hidden md:block" size="xs">
          Use the numbers <Kbd>1-6</Kbd> to rate.
          {showReasons && (
            <>
              {' '}
              <Kbd>Esc</Kbd> to cancel
            </>
          )}
        </Text>
        <ActionIcon className="ml-auto" size="sm" variant="transparent" onClick={onVolumeClick}>
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

function DamnedReasonOptions({
  onClick,
  onClose,
  mobile,
}: {
  onClick: (reason: NewOrderDamnedReason) => void;
  onClose: VoidFunction;
  mobile?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 md:flex-row">
      <Tooltip label="Cancel">
        <Button variant="default" className="order-2 md:order-1 md:h-full" onClick={onClose}>
          <div className="flex flex-nowrap items-center gap-2">
            <IconArrowBackUp />
            <Text className="md:hidden" inherit>
              Cancel
            </Text>
          </div>
        </Button>
      </Tooltip>
      <Button.Group className="order-1 md:order-2" orientation={mobile ? 'vertical' : 'horizontal'}>
        {damnedReasonOptions.map((reason) => {
          const damnedReason = NewOrderDamnedReason[reason];

          return (
            <Button
              key={reason}
              classNames={{
                root: 'md:h-auto md:max-w-[150px]',
                label: 'whitespace-normal leading-normal text-center',
              }}
              size={mobile ? 'md' : 'sm'}
              variant="default"
              onClick={() => {
                onClick(damnedReason);
                onClose();
              }}
              fullWidth
            >
              {getDisplayName(damnedReason)}
            </Button>
          );
        })}
      </Button.Group>
    </div>
  );
}
