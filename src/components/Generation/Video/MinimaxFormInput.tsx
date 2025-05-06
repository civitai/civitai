import { useFormContext } from 'react-hook-form';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import { InputSwitch, InputTextArea } from '~/libs/form';

export function MinimaxFormInput() {
  const form = useFormContext();
  const sourceImage = form.watch('sourceImage');

  return (
    <>
      <InputSourceImageUpload name="sourceImage" label="Image (optional)" className="flex-1" />
      <InputTextArea
        required={!sourceImage}
        name="prompt"
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
      />
      <InputSwitch name="enablePromptEnhancer" label="Enable prompt enhancer" />
    </>
  );
}
