import { Container, Title } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export default function PaymentSuccess() {
  const currentUser = useCurrentUser();
  console.log({ currentUser });
  return (
    <Container>
      <Title>Success</Title>
    </Container>
  );
}
