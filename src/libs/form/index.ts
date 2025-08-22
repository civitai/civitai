import {
  Textarea,
  Radio,
  Checkbox,
  Chip,
  PasswordInput,
  JsonInput,
  ColorPicker,
  ColorInput,
  Autocomplete,
  Slider,
  FileInput,
  Switch,
} from '@mantine/core';
import { DatePickerInput, TimeInput, DateTimePicker } from '@mantine/dates';
import { TagsInput } from '~/components/Tags/TagsInput';
import { RichTextEditor } from '~/components/RichTextEditor/RichTextEditor';
import { BrowsingLevelsInput } from '~/components/BrowsingLevel/BrowsingLevelInput';
import { ClubResourceManagementInput } from '~/components/Club/ClubResourceManagementInput';
import { SectionItemsInput } from '~/components/CosmeticShop/SectionItemsInput';
import { ImageUpload } from '~/components/ImageUpload/ImageUpload';
import { InlineSocialLinkInput } from '~/components/Profile/InlineSocialLinkInput';
import { ProfileSectionsSettingsInput } from '~/components/Profile/ProfileSectionsSettingsInput';
import { ShowcaseItemsInput } from '~/components/Profile/ShowcaseItemsInput';
import { ProfileImageUpload } from '~/components/ProfileImageUpload/ProfileImageUpload';
import { CollectionSelectInput } from '~/libs/form/components/CollectionSelectInput';
import { CosmeticSelect } from '~/libs/form/components/CosmeticSelect';
import { FlagInput } from '~/libs/form/components/FlagInput';
import { MultiFileInputUpload } from '~/libs/form/components/MultiFileInputUpload';
import {
  MultiSelectWrapper,
  CreatableMultiSelect,
} from '~/libs/form/components/MultiSelectWrapper';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { NumberSlider } from '~/libs/form/components/NumberSlider';
import { CustomRadioGroup } from '~/libs/form/components/RadioGroupWrapper';
import { RatingWrapper } from '~/libs/form/components/RatingWrapper';
import { SegmentedControlWrapper } from '~/libs/form/components/SegmentedControlWrapper';
import { SelectWrapper } from '~/libs/form/components/SelectWrapper';
import { SimpleImageUpload } from '~/libs/form/components/SimpleImageUpload';
import { TextInputWrapper } from '~/libs/form/components/TextInputWrapper';
import { withController } from '~/libs/form/hoc/withController';

export { useCustomFormContext, Form } from '~/libs/form/components/Form';
export type { FormProps } from '~/libs/form/components/Form';
export { useForm } from './hooks/useForm';

export const InputText = withController(TextInputWrapper);
export const InputNumber = withController(NumberInputWrapper, ({ field }) => ({
  value: field.value,
}));
export const InputTextArea = withController(Textarea);
export const InputSelect = withController(SelectWrapper);
export const InputMultiSelect = withController(MultiSelectWrapper);
export const InputCreatableMultiSelect = withController(CreatableMultiSelect);
export const InputSegmentedControl = withController(SegmentedControlWrapper);
export const InputRadioGroup = withController(Radio.Group);
export const InputCheckboxGroup = withController(Checkbox.Group);
export const InputChipGroup = withController(Chip.Group);
export const InputPasswordInput = withController(PasswordInput);
export const InputJson = withController(JsonInput);
export const InputColorPicker = withController(ColorPicker);
export const InputColorInput = withController(ColorInput);
export const InputChips = withController(Chip.Group);
export const InputAutocomplete = withController(Autocomplete);
export const InputDatePicker = withController(DatePickerInput);
export const InputRating = withController(RatingWrapper);
export const InputSlider = withController(Slider);
export const InputFileInput = withController(FileInput);
export const InputRTE = withController(RichTextEditor);
export const InputImageUpload = withController(ImageUpload);
// export const InputFileUpload = (withController(FileInputUpload));
export const InputMultiFileUpload = withController(MultiFileInputUpload);
export const InputProfileImageUpload = withController(ProfileImageUpload);
export const InputSimpleImageUpload = withController(SimpleImageUpload);
export const InputTags = withController(TagsInput);
export const InputTime = withController(TimeInput);
export const InputNumberSlider = withController(NumberSlider);
export const InputInlineSocialLinkInput = withController(InlineSocialLinkInput);
export const InputShowcaseItemsInput = withController(ShowcaseItemsInput);
export const InputClubResourceManagementInput = withController(ClubResourceManagementInput);
export const InputProfileSectionsSettingsInput = withController(ProfileSectionsSettingsInput);
export const InputDateTimePicker = withController(DateTimePicker);

export const InputSwitch = withController(Switch, ({ field }) => ({
  value: field.value ?? false,
  checked: field.value ?? false,
}));
export const InputCheckbox = withController(Checkbox, ({ field }) => ({
  value: field.value ?? false,
  checked: field.value ?? false,
}));
export const InputFlag = withController(FlagInput);
export const InputSectionItems = withController(SectionItemsInput);
export const InputCosmeticSelect = withController(CosmeticSelect);
export const InputCollectionSelect = withController(CollectionSelectInput);
export const InputCustomRadioGroup = withController(CustomRadioGroup);
export const InputBrowsingLevels = withController(BrowsingLevelsInput);
