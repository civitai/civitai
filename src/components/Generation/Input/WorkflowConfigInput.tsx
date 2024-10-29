import { AspectRatioPicker } from '~/components/Generation/Input/AspectRatioPicker';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import {
  InputNumberSlider,
  InputSelect,
  InputSwitch,
  InputText,
  InputTextArea,
} from '~/libs/form/components';

import { WorkflowConfigInputProps } from '~/shared/types/generation.types';

export function WorkflowConfigInput(props: WorkflowConfigInputProps) {
  switch (props.type) {
    case 'text':
      return <InputText {...props} />;
    case 'textarea':
      return <InputTextArea autosize {...props} />;
    case 'aspect-ratio':
      return <AspectRatioPicker {...props} />;
    case 'switch':
      return <InputSwitch {...props} />;
    case 'number-slider':
      return <InputNumberSlider {...props} />;
    case 'select':
      const { options, ...rest } = props;
      return <InputSelect {...rest} data={options} />;
    case 'seed':
      return <InputSeed {...props} />;
    default:
      return null;
  }
}
