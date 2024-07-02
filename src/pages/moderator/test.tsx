import { Box, Button, useMantineTheme } from '@mantine/core';
import { useEffect, useState } from 'react';
import { TypeOf, ZodAny, ZodArray, ZodEffects, ZodObject, ZodString, ZodTypeAny, z } from 'zod';
import { Adunit } from '~/components/Ads/AdUnit';
import { GenerationForm2 } from '~/components/ImageGeneration/GenerationForm/GenerationForm2';
import { GenerationFormProvider } from '~/components/ImageGeneration/GenerationForm/GenerationFormProvider';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';
import { IsClient } from '~/components/IsClient/IsClient';
import OnboardingWizard from '~/components/Onboarding/OnboardingWizard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form } from '~/libs/form';
import { Watch } from '~/libs/form/components/Watch';
import { usePersistForm } from '~/libs/form/hooks/usePersistForm';
import { trpc } from '~/utils/trpc';

export default function Test() {
  const theme = useMantineTheme();

  const currentUser = useCurrentUser();

  return (
    <IsClient>
      <GenerationProvider>
        <div className="container max-w-xs">
          <GenerationForm2 />
        </div>
      </GenerationProvider>
      {/* <InnerContent /> */}
    </IsClient>
  );
}

function InnerContent() {
  const [values, setValues] = useState<any>();
  const form = usePersistForm('storage-key', {
    schema: z.object({ name: z.string(), age: z.number() }),
    defaultValues: (localValues) => ({ name: 'bob', age: 23 }),
  });

  useEffect(() => {
    setTimeout(() => {
      setValues({ name: 'george' });
    }, 1000);

    setTimeout(() => {
      form.setValue('name', 'jim');
    }, 3000);
  }, []);

  return (
    <Form form={form} onSubmit={(data) => console.log(data)}>
      <div className="flex flex-col gap-3">
        <Watch {...form} fields={['name', 'age']}>
          {({ name, age }) => (
            <div>
              {name} - {age}
            </div>
          )}
        </Watch>
        <Button onClick={() => form.reset()}>Reset</Button>
        <Button type="submit">Submit</Button>
      </div>
    </Form>
  );
}
