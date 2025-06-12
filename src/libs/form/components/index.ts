import { ImageUpload } from '~/components/ImageUpload/ImageUpload';
import { RichTextEditor } from '~/components/RichTextEditor/RichTextEditor';
import { withController } from '../hoc/withController';
import { TextInputWrapper } from './TextInputWrapper';
import { NumberInputWrapper } from './NumberInputWrapper';
import {
  Autocomplete,
  Checkbox,
  Chip,
  ColorInput,
  ColorPicker,
  FileInput,
  JsonInput,
  PasswordInput,
  Radio,
  Slider,
  Switch,
  Textarea,
} from '@mantine/core';
import { SelectWrapper } from '~/libs/form/components/SelectWrapper';
import {
  CreatableMultiSelect,
  MultiSelectWrapper,
} from '~/libs/form/components/MultiSelectWrapper';
import { DatePickerInput, TimeInput } from '@mantine/dates';
import { FileInputUpload } from '~/components/FileInputUpload/FileInputUpload';
import { ProfileImageUpload } from '~/components/ProfileImageUpload/ProfileImageUpload';
import { RatingWrapper } from '~/libs/form/components/RatingWrapper';
import { TagsInput } from '~/components/Tags/TagsInput';
import { MultiFileInputUpload } from './MultiFileInputUpload';
import { SimpleImageUpload } from './SimpleImageUpload';
import { NumberSlider } from '~/libs/form/components/NumberSlider';
import { InlineSocialLinkInput } from '~/components/Profile/InlineSocialLinkInput';
import { ShowcaseItemsInput } from '~/components/Profile/ShowcaseItemsInput';
import { ProfileSectionsSettingsInput } from '~/components/Profile/ProfileSectionsSettingsInput';
import { ClubResourceManagementInput } from '~/components/Club/ClubResourceManagementInput';
import { FlagInput } from '~/libs/form/components/FlagInput';
import { SectionItemsInput } from '~/components/CosmeticShop/SectionItemsInput';
import { CosmeticSelect } from '~/libs/form/components/CosmeticSelect';
import { CollectionSelectInput } from '~/libs/form/components/CollectionSelectInput';
import { CustomRadioGroup } from '~/libs/form/components/RadioGroupWrapper';
import { SegmentedControlWrapper } from '~/libs/form/components/SegmentedControlWrapper';
import { BrowsingLevelsInput } from '~/components/BrowsingLevel/BrowsingLevelInput';

export * from './Form';

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
