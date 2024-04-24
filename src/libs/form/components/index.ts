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
  SegmentedControl,
  Slider,
  Switch,
  Textarea,
  TransferList,
} from '@mantine/core';
import { SelectWrapper } from '~/libs/form/components/SelectWrapper';
import { MultiSelectWrapper } from '~/libs/form/components/MultiSelectWrapper';
import { DatePicker, TimeInput } from '@mantine/dates';
import { FileInputUpload } from '~/components/FileInputUpload/FileInputUpload';
import { ProfileImageUpload } from '~/components/ProfileImageUpload/ProfileImageUpload';
import { withWatcher } from '~/libs/form/hoc/withWatcher';
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

export * from './Form';

export const InputText = withWatcher(withController(TextInputWrapper));
export const InputNumber = withWatcher(
  withController(NumberInputWrapper, ({ field }) => ({
    value: field.value,
  }))
);
export const InputTextArea = withWatcher(withController(Textarea));
export const InputTransferList = withWatcher(withController(TransferList));
export const InputSelect = withWatcher(withController(SelectWrapper));
export const InputMultiSelect = withWatcher(withController(MultiSelectWrapper));
export const InputSegmentedControl = withWatcher(withController(SegmentedControl));
export const InputRadioGroup = withWatcher(withController(Radio.Group));
export const InputCheckboxGroup = withWatcher(withController(Checkbox.Group));
export const InputChipGroup = withWatcher(withController(Chip.Group));
export const InputPasswordInput = withWatcher(withController(PasswordInput));
export const InputJson = withWatcher(withController(JsonInput));
export const InputColorPicker = withWatcher(withController(ColorPicker));
export const InputColorInput = withWatcher(withController(ColorInput));
export const InputChips = withWatcher(withController(Chip.Group));
export const InputAutocomplete = withWatcher(withController(Autocomplete));
export const InputDatePicker = withWatcher(withController(DatePicker));
export const InputRating = withWatcher(withController(RatingWrapper));
export const InputSlider = withWatcher(withController(Slider));
export const InputFileInput = withWatcher(withController(FileInput));
export const InputRTE = withWatcher(withController(RichTextEditor));
export const InputImageUpload = withWatcher(withController(ImageUpload));
// export const InputFileUpload = withWatcher(withController(FileInputUpload));
export const InputMultiFileUpload = withWatcher(withController(MultiFileInputUpload));
export const InputProfileImageUpload = withWatcher(withController(ProfileImageUpload));
export const InputSimpleImageUpload = withWatcher(withController(SimpleImageUpload));
export const InputTags = withWatcher(withController(TagsInput));
export const InputTime = withWatcher(withController(TimeInput));
export const InputNumberSlider = withWatcher(withController(NumberSlider));
export const InputInlineSocialLinkInput = withWatcher(withController(InlineSocialLinkInput));
export const InputShowcaseItemsInput = withWatcher(withController(ShowcaseItemsInput));
export const InputClubResourceManagementInput = withWatcher(
  withController(ClubResourceManagementInput)
);
export const InputProfileSectionsSettingsInput = withWatcher(
  withController(ProfileSectionsSettingsInput)
);

export const InputSwitch = withWatcher(
  withController(Switch, ({ field }) => ({
    value: field.value ?? false,
    checked: field.value ?? false,
  }))
);
export const InputCheckbox = withWatcher(
  withController(Checkbox, ({ field }) => ({
    value: field.value ?? false,
    checked: field.value ?? false,
  }))
);
export const InputFlag = withWatcher(withController(FlagInput));
export const InputSectionItems = withWatcher(withController(SectionItemsInput));
export const InputCosmeticSelect = withWatcher(withController(CosmeticSelect));
