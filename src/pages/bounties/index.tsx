import { Container, Grid, Group, Title } from '@mantine/core';
import { Bounties } from '~/components/Bounties/BountiesProvider';
import { InfiniteBounties } from '~/components/InfiniteBounties/InfiniteBounties';

export default function BountiesPage() {
  return (
    <Container size="xl">
      <Bounties>
        <Grid>
          <Grid.Col span={12}>
            <Group position="apart">
              <Bounties.Sort />
              <Title order={1}>Bounties</Title>
              <Group spacing={8}>
                <Bounties.Period />
                <Bounties.Filter />
              </Group>
            </Group>
          </Grid.Col>
          <Grid.Col span={12}>
            <InfiniteBounties />
          </Grid.Col>
        </Grid>
      </Bounties>
    </Container>
  );
}
