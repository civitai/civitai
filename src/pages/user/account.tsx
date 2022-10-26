import { Button, Container, Stack, Switch, TextInput, Title } from '@mantine/core';
import { GetServerSideProps } from 'next';
import { Session } from 'next-auth';
import { getServerAuthSession } from '~/server/common/get-server-auth-session';
import { useForm } from '@mantine/form';
import { signIn } from 'next-auth/react';
import { trpc } from '~/utils/trpc';

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
  const { mutateAsync, isLoading } = trpc.user.update.useMutation();

  const form = useForm({
    initialValues: user,
  });

  return (
    <Container p={0} size="xs">
      <form
        onSubmit={form.onSubmit(async (values) => {
          await mutateAsync(values);
          signIn();
        })}
      >
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
          <Button type="submit" loading={isLoading} disabled={!form.isDirty()}>
            Save
          </Button>
        </Stack>
      </form>
    </Container>
  );
}
