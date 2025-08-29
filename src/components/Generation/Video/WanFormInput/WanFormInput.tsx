import { Radio, Text } from '@mantine/core';
import { useFormContext } from 'react-hook-form';
import { InputRadioGroup } from '~/libs/form';
import { wanGenerationConfig, wanVersions } from '~/server/orchestrator/wan/wan.schema';
import { Wan21FormInput } from '~/components/Generation/Video/WanFormInput/Wan21FormInput';
import { Wan22FormInput } from '~/components/Generation/Video/WanFormInput/Wan22FormInput';
import { Wan225bFormInput } from '~/components/Generation/Video/WanFormInput/Wan225bFormInput';
import { useLayoutEffect } from 'react';

export function WanFormInput() {
  const form = useFormContext();
  const version = form.watch('version');

  useLayoutEffect(() => {
    const values = form.getValues();
    form.reset({
      ...wanGenerationConfig.softValidate(values),
      resources: values.resources, // included to keep extra data from being stripped by the schema validation
    });
  }, [version]);

  return (
    <>
      <InputRadioGroup name="version" label="Version" className="-mt-2 ">
        <div className="flex gap-2">
          {wanVersions.map((value) => (
            <Radio.Card key={value} value={value} className="flex items-center gap-3 px-4 py-2">
              <Radio.Indicator />
              <Text>{value}</Text>
            </Radio.Card>
          ))}
        </div>
      </InputRadioGroup>
      {version === 'v2.1' && <Wan21FormInput />}
      {version === 'v2.2' && <Wan22FormInput />}
      {version === 'v2.2-5b' && <Wan225bFormInput />}
    </>
  );
}
