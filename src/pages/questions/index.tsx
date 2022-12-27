import { Container, Stack, Title, Group, Button } from '@mantine/core';
import { GetServerSideProps } from 'next';
import Link from 'next/link';
import { getServerProxySSGHelpers } from '~/server/utils/getServerProxySSGHelpers';

import { Meta } from '~/components/Meta/Meta';
import { Questions } from '~/components/Questions/Questions.Provider';
import { constants } from '~/server/common/constants';
import { parseCookies } from '~/providers/CookiesProvider';

export const getServerSideProps: GetServerSideProps = async (context) => {
  const page = context.query.page ? Number(context.query.page) : 1;
  const {
    sort = constants.questionFilterDefaults.sort,
    period = constants.questionFilterDefaults.period,
    status,
  } = parseCookies(context.req.cookies).questions;

  const ssg = await getServerProxySSGHelpers(context);
  await ssg.question.getPaged.prefetch({
    page,
    limit: constants.questionFilterDefaults.limit,
    sort,
    period,
    status,
  });

  return {
    props: {
      trpcState: ssg.dehydrate(),
    },
  };
};

export default function QuestionsList() {
  return (
    <>
      <Meta title="Questions | Civitai" />
      <Container pb="xl">
        <Stack spacing="md">
          <Group position="apart">
            <Title>Questions</Title>
            <Group>
              <Link href="/questions/create" passHref>
                <Button component="a">Ask question</Button>
              </Link>
            </Group>
          </Group>
          <Questions>
            <Group position="apart">
              <Questions.Sort />
              <Group spacing="xs">
                <Questions.Period />
                <Questions.Filter />
              </Group>
            </Group>
            <Questions.List />
          </Questions>
        </Stack>
      </Container>
    </>
  );
}
