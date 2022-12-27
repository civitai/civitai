import { Container, Grid, Group, Title } from '@mantine/core';
import { InfiniteBounties } from '~/components/InfiniteBounties/InfiniteBounties';

export default function Bounties() {
  return (
    <Container size="xl">
      <Grid>
        <Grid.Col span={12}>
          <Group position="apart">
            <Title order={1}>Bounties</Title>
          </Group>
        </Grid.Col>
        <Grid.Col span={12}>
          <InfiniteBounties />
        </Grid.Col>
      </Grid>
    </Container>
  );
}
