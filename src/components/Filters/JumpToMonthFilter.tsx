import { Tooltip } from '@mantine/core';
import { MonthPickerInput } from '@mantine/dates';
import { IconCalendarMonth } from '@tabler/icons-react';
import { useIsMobile } from '~/hooks/useIsMobile';
import { isJumpToSort, monthToPickerDate, pickerDateToMonth } from '~/shared/utils/jump-to-month';

export function JumpToMonthFilter({ value, sort, onChange }: Props) {
  const mobile = useIsMobile();
  const enabled = isJumpToSort(sort);

  return (
    <Tooltip label="Available with Newest and Oldest" disabled={enabled}>
      <div>
        <MonthPickerInput
          aria-label="Jump to month"
          placeholder="Jump to a month"
          leftSection={<IconCalendarMonth size={16} />}
          valueFormat="MMMM YYYY"
          value={monthToPickerDate(value)}
          onChange={(date) => onChange(pickerDateToMonth(date))}
          maxDate={new Date()}
          disabled={!enabled}
          dropdownType={mobile ? 'modal' : 'popover'}
          clearable
          clearButtonProps={{ 'aria-label': 'Clear month' }}
        />
      </div>
    </Tooltip>
  );
}

type Props = {
  value?: string;
  sort?: string;
  onChange: (month: string | undefined) => void;
};
