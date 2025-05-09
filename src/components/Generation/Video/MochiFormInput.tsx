import { useFormContext } from 'react-hook-form';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { InputSwitch, InputTextArea } from '~/libs/form';

export function MochiFormInput() {
  const form = useFormContext();

  return (
    <>
      <InputTextArea
        required
        name="prompt"
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
      />
      <InputSwitch name="enablePromptEnhancer" label="Enable prompt enhancer" />
      <DescriptionTable
        items={[
          { label: 'Aspect Ratio', value: '16:9' },
          { label: 'Resolution', value: '848x480 (480p)' },
          { label: 'Duration', value: '5s' },
        ]}
      />
      <InputSeed name="seed" label="Seed" />
    </>
  );
}
