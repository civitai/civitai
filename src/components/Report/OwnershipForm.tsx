import { Alert, Stack, Radio, Text } from '@mantine/core';
import * as z from 'zod';
import { InputText, InputRTE, InputImageUpload, InputRadioGroup } from '~/libs/form';
import { imageSchema } from '~/server/schema/image.schema';
import { reportOwnershipDetailsSchema } from '~/server/schema/report.schema';
import { createReportForm } from './create-report-form';

const schema = reportOwnershipDetailsSchema.extend({
  establishInterest: z.string().transform((x) => (x === 'yes' ? true : false)),
  images: imageSchema.array().transform((images) => images?.map((x) => x.url)),
});

export const OwnershipForm = createReportForm({
  schema,
  Element: ({ props: { setUploading } }) => {
    return (
      <>
        <Alert>
          <Text>
            If you believe that this model may have been trained using your art, please complete the
            form below for review. A review of the claim will only be opened if this is placed by
            the original artist.
          </Text>
        </Alert>
        <InputText name="name" label="Name" withAsterisk clearable={false} />
        <InputText
          name="email"
          label="Email"
          description="We will contact you at this address to verify the legitimacy of your claim"
          withAsterisk
          clearable={false}
        />
        <InputText name="phone" label="Phone" clearable={false} />
        <InputRTE name="comment" label="Comment" />
        <InputImageUpload
          name="images"
          label="Images for comparison"
          withMeta={false}
          onChange={(values) => setUploading(values.some((x) => x.file))}
          withAsterisk
        />
        <InputRadioGroup
          name="establishInterest"
          withAsterisk
          label="Are you interested in having an official model of your art style created and
                attributed to you?"
          description={
            <Text>
              You would receive 70% of any proceeds made from the use of your model on Civitai.{' '}
              <Text component="a" href="/content/art-and-ai#monetizing-your-art" target="_blank">
                Learn more
              </Text>
            </Text>
          }
        >
          <Stack gap={4}>
            <Radio value="yes" label="I'm interested" />
            <Radio value="no" label="Not at this time" />
          </Stack>
        </InputRadioGroup>
      </>
    );
  },
});
