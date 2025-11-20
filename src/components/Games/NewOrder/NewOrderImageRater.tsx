import { Button, Kbd, ActionIcon, Tooltip, Text, Modal, Popover } from '@mantine/core';
import type { HotkeyItem } from '@mantine/hooks';
import { useHotkeys } from '@mantine/hooks';
import {
  IconArrowBackUp,
  IconFlag,
  IconVolumeOff,
  IconVolume,
  IconHelpHexagon,
} from '@tabler/icons-react';
import { useState, useMemo, useCallback } from 'react';
import { openBrowsingLevelGuide } from '~/components/Dialog/triggers/browsing-level-guide';
import { damnedReasonOptions, ratingOptions } from '~/components/Games/KnightsNewOrder.utils';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useIsMobile } from '~/hooks/useIsMobile';
import { NewOrderDamnedReason, NsfwLevel } from '~/server/common/enums';
import { browsingLevelDescriptions } from '~/shared/constants/browsingLevel.constants';
import { getDisplayName } from '~/utils/string-helpers';

let timeoutRef: NodeJS.Timeout | undefined;

export function NewOrderImageRater({
  muted,
  disabled,
  onRatingClick,
  onVolumeClick,
  onSkipClick,
}: Props) {
  const mobile = useIsMobile({ breakpoint: 'md' });
  const [showReasons, setShowReasons] = useState(false);

  const debouncedRatingClick = useCallback(
    (data: { rating: NsfwLevel; damnedReason?: NewOrderDamnedReason }) => {
      if (disabled) return;
      if (timeoutRef) {
        clearTimeout(timeoutRef);
      }
      timeoutRef = setTimeout(() => {
        onRatingClick(data);
        setShowReasons(false);
      }, 200);
    },
    [disabled, onRatingClick]
  );

  const debouncedSkipClick = useCallback(() => {
    if (timeoutRef) {
      clearTimeout(timeoutRef);
    }
    timeoutRef = setTimeout(() => {
      onSkipClick();
      setShowReasons(false);
    }, 200);
  }, [onSkipClick]);

  const handleHotkeyPress = useCallback(
    (data: { rating: NsfwLevel; damnedReason?: NewOrderDamnedReason }) => {
      return () => debouncedRatingClick(data);
    },
    [debouncedRatingClick]
  );

  const hotKeys: HotkeyItem[] = useMemo(() => {
    if (disabled) return [];

    return showReasons
      ? [
          [
            '1',
            handleHotkeyPress({
              rating: NsfwLevel.Blocked,
              damnedReason: NewOrderDamnedReason.InappropriateMinors,
            }),
          ],
          [
            '2',
            handleHotkeyPress({
              rating: NsfwLevel.Blocked,
              damnedReason: NewOrderDamnedReason.RealisticMinors,
            }),
          ],
          [
            '3',
            handleHotkeyPress({
              rating: NsfwLevel.Blocked,
              damnedReason: NewOrderDamnedReason.DepictsRealPerson,
            }),
          ],
          [
            '4',
            handleHotkeyPress({
              rating: NsfwLevel.Blocked,
              damnedReason: NewOrderDamnedReason.Bestiality,
            }),
          ],
          [
            '5',
            handleHotkeyPress({
              rating: NsfwLevel.Blocked,
              damnedReason: NewOrderDamnedReason.Other,
            }),
          ],
        ]
      : [
          ['1', handleHotkeyPress({ rating: NsfwLevel.PG })],
          ['2', handleHotkeyPress({ rating: NsfwLevel.PG13 })],
          ['3', handleHotkeyPress({ rating: NsfwLevel.R })],
          ['4', handleHotkeyPress({ rating: NsfwLevel.X })],
          ['5', handleHotkeyPress({ rating: NsfwLevel.XXX })],
          ['6', () => setShowReasons(true)],
        ];
  }, [disabled, showReasons, handleHotkeyPress]);

  useHotkeys([
    ['m', () => onVolumeClick()],
    ['Escape', () => setShowReasons(false)],
    ['Space', debouncedSkipClick],
    ...hotKeys,
  ]);

  const handleRatingClick = useCallback(
    (data: { rating: NsfwLevel; damnedReason?: NewOrderDamnedReason }) => {
      debouncedRatingClick(data);
    },
    [debouncedRatingClick]
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap justify-center gap-2">
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
                  handleRatingClick({ rating: NsfwLevel.Blocked, damnedReason })
                }
                onClose={() => setShowReasons(false)}
                mobile
              />
            </Modal>
          ) : (
            <DamnedReasonOptions
              onClick={(damnedReason) =>
                handleRatingClick({ rating: NsfwLevel.Blocked, damnedReason })
              }
              onClose={() => setShowReasons(false)}
            />
          )
        ) : (
          <>
            <Button.Group>
              {ratingOptions.map((rating) => {
                const level = NsfwLevel[rating];
                const isBlocked = level === 'Blocked';

                return (
                  <Tooltip
                    key={rating}
                    label={browsingLevelDescriptions[rating]}
                    position="top"
                    openDelay={500}
                    maw={350}
                    withArrow
                    multiline
                  >
                    <Button
                      key={rating}
                      size={mobile ? 'xs' : undefined}
                      variant={isBlocked ? 'filled' : 'default'}
                      color={isBlocked ? 'red' : undefined}
                      onClick={() =>
                        isBlocked ? setShowReasons(true) : handleRatingClick({ rating })
                      }
                      disabled={disabled}
                    >
                      {isBlocked ? <IconFlag size={18} /> : level}
                    </Button>
                  </Tooltip>
                );
              })}
            </Button.Group>
            <Button variant="default" size={mobile ? 'xs' : undefined} onClick={debouncedSkipClick}>
              Skip
            </Button>
          </>
        )}
      </div>
      <div className="flex w-full justify-between gap-2">
        <Text className="hidden md:block" size="xs">
          {showReasons ? (
            <>
              Use the numbers <Kbd>1-5</Kbd> to rate, <Kbd>Esc</Kbd> to cancel
            </>
          ) : (
            <>
              Use the numbers <Kbd>1-6</Kbd> to rate, <Kbd>Space</Kbd> to skip.
            </>
          )}
        </Text>
        <div className="flex items-center gap-1">
          <LegacyActionIcon
            className="ml-auto"
            size="sm"
            variant="transparent"
            onClick={onVolumeClick}
          >
            {muted ? <IconVolumeOff size={16} /> : <IconVolume size={16} />}
          </LegacyActionIcon>
          <ExplainImageRaterPopover />
        </div>
      </div>
    </div>
  );
}

type Props = {
  onRatingClick: (data: { rating: NsfwLevel; damnedReason?: NewOrderDamnedReason }) => void;
  onVolumeClick: () => void;
  onSkipClick: () => void;
  muted?: boolean;
  disabled?: boolean;
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

export function ExplainImageRaterPopover() {
  return (
    <Popover width={300} withArrow>
      <Popover.Target>
        <LegacyActionIcon size="xs" color="dark">
          <IconHelpHexagon strokeWidth={2.5} />
        </LegacyActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Text c="orange" fw={500}>
          What is this?
        </Text>
        <Text
          size="sm"
          lh={1.3}
        >{`We're working on improving our automated content moderation system. We need your help to improve our data! Please assign the rating you think best fits the content`}</Text>
        <Text
          className="cursor-pointer"
          size="xs"
          td="underline"
          color="blue.4"
          onClick={openBrowsingLevelGuide}
        >
          What do the ratings mean?
        </Text>
      </Popover.Dropdown>
    </Popover>
  );
}
