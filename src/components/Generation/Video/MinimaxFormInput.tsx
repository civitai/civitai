import { useFormContext } from 'react-hook-form';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import { InputVideoProcess } from '~/components/Generation/Input/VideoProcess';
import { InputSwitch, InputTextArea } from '~/libs/form';

export function MinimaxFormInput() {
  const form = useFormContext();
  const process = form.watch('process');

  return (
    <>
      <InputVideoProcess name="process" />
      {process === 'img2vid' && <InputSourceImageUpload name="sourceImage" className="flex-1" />}
      <InputTextArea
        required={process === 'txt2vid'}
        name="prompt"
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
      />
      <InputSwitch name="enablePromptEnhancer" label="Enable prompt enhancer" />
    </>
  );
}
