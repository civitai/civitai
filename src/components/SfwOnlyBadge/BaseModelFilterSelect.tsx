import { MultiSelect } from '@mantine/core';
import { renderBaseModelOption } from '~/components/SfwOnlyBadge/SfwOnlyBadge';
import { isMobileDevice } from '~/hooks/useIsMobile';
import type { BaseModel } from '~/shared/constants/basemodel.constants';
import {
  baseModelSelectData,
  imageBaseModelSelectData,
} from '~/shared/constants/basemodel.constants';

// The base model filter shared by the Models and Images filter dropdowns.
export function BaseModelFilterSelect({
  value,
  onChange,
  includeHidden,
}: {
  value: string[];
  onChange: (baseModels: BaseModel[]) => void;
  /** Also list the hidden bases, which have images but no models. */
  includeHidden?: boolean;
}) {
  return (
    <MultiSelect
      data={includeHidden ? imageBaseModelSelectData : baseModelSelectData}
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
