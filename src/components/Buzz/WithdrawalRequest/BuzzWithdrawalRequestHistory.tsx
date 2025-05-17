import { Popover, Stack, Text, Group, Badge, Divider } from '@mantine/core';
import { IconInfoSquareRounded } from '@tabler/icons-react';
import { WithdrawalRequestBadgeColor } from '~/components/Buzz/buzz.styles';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { BuzzWithdrawalRequestHistoryRecord } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

const BuzzWithdrawalRequestHistory = ({
  history,
}: {
  history: BuzzWithdrawalRequestHistoryRecord;
}) => {
  return (
    <Popover width={300} withArrow withinPortal shadow="sm">
      <Popover.Target>
        <LegacyActionIcon color="gray">
          <IconInfoSquareRounded size={20} />
        </LegacyActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Text size="sm" weight={500}>
            History
          </Text>
          {history.map((record) => (
            <Stack key={record.id}>
              <Group wrap="nowrap" justify="space-between">
                {'updatedBy' in record ? (
                  <UserAvatar
                    user={record.updatedBy}
                    size="xs"
                    subText={`Actioned on ${formatDate(record.createdAt)}`}
                    withUsername
                  />
                ) : (
                  <Text size="xs" weight={500}>
                    On {formatDate(record.createdAt)}
                  </Text>
                )}

                <Badge size="xs" color={WithdrawalRequestBadgeColor[record.status]} variant="light">
                  {getDisplayName(record.status)}
                </Badge>
              </Group>
              {record.note && (
                <Text size="xs">
                  <Text weight={500}>Note:</Text> {record.note}
                </Text>
              )}
              <Divider />
            </Stack>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
};

export default BuzzWithdrawalRequestHistory;
