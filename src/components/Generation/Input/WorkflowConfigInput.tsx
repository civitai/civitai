import { AspectRatioPicker } from '~/components/Generation/Input/AspectRatioPicker';
import { InputText, InputTextArea } from '~/libs/form/components';

import { WorkflowConfigInputProps } from '~/shared/types/generation.types';

export function WorkflowConfigInput(props: WorkflowConfigInputProps) {
  switch (props.type) {
    case 'text':
      return <InputText {...props} />;
    case 'textarea':
      return <InputTextArea autosize {...props} />;
    case 'aspect-ratio':
      return <AspectRatioPicker {...props} />;
    default:
      return null;
  }
}
