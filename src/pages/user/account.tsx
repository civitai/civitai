import { Container, Stack, Switch, TextInput, Title } from '@mantine/core';
import { GetServerSideProps } from 'next';
import { useState } from 'react';
import { getSessionUser } from '~/pages/api/auth/[...nextauth]';

type Props = {
  user: Awaited<ReturnType<typeof getUserById>>;
};

const getUserById = async (id?: number) => await prisma?.user.findUnique({ where: { id } });

export const getServerSideProps: GetServerSideProps<Props> = async (context) => {
  const sessionUser = await getSessionUser(context);
  const user = await getUserById(sessionUser?.id);

  if (!user)
    return {
      redirect: {
        destination: '/',
        permanent: false,
      },
    };

  return {
    props: {
      user,
    },
  };
};

export default function Account({ user }: Props) {
  const [showNsfw, setShowNsfw] = useState(user?.showNsfw ?? false);
  const [blurNsfw, setBlurNsfw] = useState(user?.blurNsfw ?? true);

  console.log({ showNsfw });

  return (
    <Container p={0} size="xs">
      <Stack>
        <Title>Manage Account</Title>
        <TextInput label="User Name" required />
        <Switch
          label="I am of legal age to view NSFW content"
          checked={showNsfw}
          onChange={(e) => setShowNsfw(e.target.checked)}
        />
        <Switch
          label="Blur NSFW content"
          checked={blurNsfw}
          onChange={(e) => setBlurNsfw(e.target.checked)}
        />
      </Stack>
    </Container>
  );
}
