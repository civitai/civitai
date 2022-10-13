import { Container } from '@mantine/core';
import { useForm, zodResolver } from '@mantine/form';
import { modelSchema } from '~/server/validation/model';

const Create = () => {
  const form = useForm({
    validate: zodResolver(modelSchema),
    initialValues: {
      name: '',
      description: '',
      type: '',
      trainedWords: [],
      tags: [],
      nsfw: false,
      modelVersions: [],
    },
  });

  return (
    <Container>
      <h1>Create</h1>
    </Container>
  );
};

export default Create;
