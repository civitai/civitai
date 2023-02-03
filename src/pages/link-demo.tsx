import { Container, Group, Stack, Title } from '@mantine/core';
import { useCivitaiLink } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { Meta } from '~/components/Meta/Meta';

function Home() {
  const { resources } = useCivitaiLink();

  return (
    <>
      <Container size="xl">
        {resources && resources.map((x) => <p key={x.name}>{x.name}</p>)}
      </Container>
    </>
  );
}

// Home.getLayout = (page: React.ReactElement) => <>{page}</>;
export default Home;
