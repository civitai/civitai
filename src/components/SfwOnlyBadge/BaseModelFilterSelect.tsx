import { MultiSelect } from '@mantine/core';
import { renderBaseModelOption } from '~/components/SfwOnlyBadge/SfwOnlyBadge';
import { isMobileDevice } from '~/hooks/useIsMobile';
import type { BaseModel } from '~/shared/constants/basemodel.constants';
import { baseModelSelectData } from '~/shared/constants/basemodel.constants';

// The base model filter shared by the Models and Images filter dropdowns.
export function BaseModelFilterSelect({
  value,
  onChange,
}: {
  value: string[];
  onChange: (baseModels: BaseModel[]) => void;
}) {
  return (
    <MultiSelect
      data={baseModelSelectData}
      value={value}
      onChange={(baseModels) => onChange(baseModels as BaseModel[])}
      placeholder="All Base Models"
      searchable={!isMobileDevice()}
      clearable
      renderOption={renderBaseModelOption}
      comboboxProps={{ withinPortal: false }}
    />
  );
}
