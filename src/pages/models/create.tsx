import { Button, Container, Select, Stack, TextInput } from '@mantine/core';
import { useForm, zodResolver } from '@mantine/form';
import { z } from 'zod';
import { modelSchema } from '~/server/common/validation/model';

type CreateModelProps = Partial<z.infer<typeof modelSchema>>;

const Create = () => {
  const form = useForm<CreateModelProps>({
    validate: zodResolver(modelSchema.passthrough()),
    initialValues: {
      name: '',
      description: '',
      trainedWords: [],
      // type: 'Checkpoint',
      tags: [],
      nsfw: false,
      modelVersions: [],
    },
  });

  const handleSubmit = (data: CreateModelProps) => {
    console.log({ data });
  };

  const handleError = (error: any) => {};

  return (
    <Container>
      <form onSubmit={form.onSubmit(handleSubmit, handleError)}>
        <Stack>
          <TextInput label="Name" placeholder="Name" id="name" />
          <Select
            label="Type"
            placeholder="Type"
            {...form.getInputProps('type')}
            data={['Checkpoint', 'TextualInversion', 'Hypernetwork']}
            required
          />
          <Button type="submit">Submit</Button>
        </Stack>
      </form>
    </Container>
  );
};

export default Create;
