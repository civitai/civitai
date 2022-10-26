import { Button, Container, Stack, Switch, TextInput, Title } from '@mantine/core';
import { GetServerSideProps } from 'next';
import { Session } from 'next-auth';
import { getServerAuthSession } from '~/server/common/get-server-auth-session';
import { useForm } from '@mantine/form';

type Props = {
  user: Session['user'];
};

export const getServerSideProps: GetServerSideProps<Props> = async (context) => {
  const session = await getServerAuthSession(context);

  if (!session)
    return {
      redirect: {
        destination: '/',
        permanent: false,
      },
    };

  return { props: { user: session.user } };
};

export default function Account({ user }: Props) {
  const form = useForm({
    initialValues: user,
  });

  return (
    <Container p={0} size="xs">
      <form onSubmit={form.onSubmit((values) => console.log({ values }))}>
        <Stack>
          <Title>Manage Account</Title>
          <TextInput label="Username" required {...form.getInputProps('username')} />
          <Switch
            label="I am of legal age to view NSFW content"
            checked={form.values.showNsfw}
            {...form.getInputProps('showNsfw')}
          />
          <Switch
            label="Blur NSFW content"
            checked={form.values.blurNsfw}
            {...form.getInputProps('blurNsfw')}
          />
          <Button type="submit">Submit</Button>
        </Stack>
      </form>
    </Container>
  );
}
