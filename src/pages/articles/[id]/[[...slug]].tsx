import {
  Badge,
  Container,
  Divider,
  Group,
  Image,
  Stack,
  Text,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { InferGetServerSidePropsType } from 'next';
import { SessionUser } from 'next-auth';
import Link from 'next/link';
import React from 'react';
import { z } from 'zod';

import { NotFound } from '~/components/AppLayout/NotFound';
import { ArticleContextMenu } from '~/components/Article/ArticleContextMenu';
import { ArticleDetailComments } from '~/components/Article/Detail/ArticleDetailComments';
import { Collection } from '~/components/Collection/Collection';
import { CreatorCard } from '~/components/CreatorCard/CreatorCard';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { ReactionPicker } from '~/components/ReactionPicker/ReactionPicker';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { SensitiveShield } from '~/components/SensitiveShield/SensitiveShield';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { parseNumericString } from '~/utils/query-string-helpers';
import { trpc } from '~/utils/trpc';

const querySchema = z.object({
  id: z.preprocess(parseNumericString, z.number()),
  slug: z.array(z.string()).optional(),
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const result = querySchema.safeParse(ctx.query);
    if (!result.success) {
      console.log(result.error.flatten());
      return { notFound: true };
    }

    if (ssg) await ssg.article.getById.prefetch({ id: result.data.id });

    return { props: removeEmpty(result.data) };
  },
});

const fakeArticle = (user?: SessionUser | null) => ({
  id: 1,
  user,
  title: 'Article title',
  content: `<h2>Pokemon list 1</h2><p>
  Shieldon kangaskhan escavalier krabby shedinja totodile blitzle gyarados poochyena swellow metapod doduo lucario hoppip venonat solosis rampardos crawdaunt phanpy joltik rapidash garbodor voltorb tympole electivire lairon feraligatr vaporeon wartortle snorlax.
  </p>
  <h3>More pokemons</h3><p>
  Staryu gloom tympole kingler drifloon raikou bastiodon sandshrew simisage lapras gabite clamperl mightyena flareon grotle bulbasaur feebas natu donphan emolga herdier shroomish mr skiploom salamence lugia aipom nincada gulpin weavile.
  </p>
  <p>
  Hitmontop scrafty yanma blissey marill elgyem smeargle mightyena donphan lumineon bellossom carracosta meloetta pikachu nidoran unown krabby machoke braviary beheeyem mime druddigon persian beautifly simisage nuzleaf doduo whimsicott celebi geodude.
  </p>
  <p>
  Surskit cobalion omanyte onix kyogre regigigas bayleef pawniard jellicent alakazam, pawniard bonsly starmie spinarak infernape joltik axew mime garbodor arbok shellder chandelure miltank swellow beartic noctowl nidoran koffing mime whiscash.
  </p>
  <p>
  Nidoran slakoth cryogonal jynx lotad klang seel absol totodile emboar slowking blissey mienshao sharpedo raichu cobalion dodrio rattata registeel lombre metang munna lillipup cascoon kricketune arceus glaceon articuno buizel dustox!
  </p>`,
  cover: 'https://picsum.photos/1320?random=1',
  publishedAt: new Date(),
  nsfw: true,
  tags: [
    { id: 1, name: 'Lorem', isCategory: true },
    { id: 2, name: 'ipsum', isCategory: false },
    { id: 3, name: 'dolor', isCategory: false },
    { id: 4, name: 'sit', isCategory: false },
  ],
  reactions: [],
});

export default function ArticleDetailsPage({
  id,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const currentUser = useCurrentUser();
  const theme = useMantineTheme();

  const { data: article = fakeArticle(currentUser), isLoading } = trpc.article.getById.useQuery({
    id,
  });

  // TODO.articles: add meta description
  const meta = <Meta title={`Civitai | ${article?.title}`} />;

  if (isLoading) return <PageLoader />;
  if (!article) return <NotFound />;

  if (article?.nsfw && !currentUser)
    return (
      <>
        {meta}
        <SensitiveShield />
      </>
    );

  const category = article.tags.find((tag) => tag.isCategory);
  const tags = article.tags.filter((tag) => !tag.isCategory);

  return (
    <>
      {meta}
      <Container size="md">
        <Stack spacing="xl">
          <Stack spacing={0}>
            <Group position="apart" noWrap>
              <Title weight="bold">{article.title}</Title>
              {article.user && <ArticleContextMenu article={article} />}
            </Group>
            <Group spacing={8}>
              <UserAvatar user={article.user} withUsername linkToProfile />
              <Divider orientation="vertical" />
              <Text color="dimmed" size="sm">
                {article.publishedAt ? formatDate(article.publishedAt) : 'Draft'}
              </Text>
              {category && (
                <>
                  <Divider orientation="vertical" />

                  <Link href={`/articles?tags=${category.id}`} passHref>
                    <Badge
                      component="a"
                      size="sm"
                      variant="gradient"
                      gradient={{ from: 'cyan', to: 'blue' }}
                      sx={{ cursor: 'pointer' }}
                    >
                      {category.name}
                    </Badge>
                  </Link>
                </>
              )}
              {!!tags.length && (
                <>
                  <Divider orientation="vertical" />
                  <Collection
                    items={tags}
                    renderItem={(tag) => (
                      <Link key={tag.id} href={`/articles?tags=${tag.id}`} passHref>
                        <Badge
                          component="a"
                          color="gray"
                          variant={theme.colorScheme === 'dark' ? 'filled' : undefined}
                          sx={{ cursor: 'pointer' }}
                        >
                          {tag.name}
                        </Badge>
                      </Link>
                    )}
                    limit={2}
                    grouped
                  />
                </>
              )}
            </Group>
          </Stack>

          <Image
            radius="md"
            h={'calc(100vh / 3)'}
            src={article.cover}
            height={'100%'}
            styles={{ imageWrapper: { height: '100%' }, figure: { height: '100%' } }}
            // width={1320}
            alt={article.title}
          />
          <RenderHtml html={article.content} />
          <Divider />
          <Group position="apart" align="flex-start">
            <ReactionPicker
              reactions={article.reactions}
              onSelect={(emoji) => console.log(emoji)}
            />
            <CreatorCard user={article.user} />
          </Group>
          <Title order={2}>Comments</Title>
          {article.user && (
            <ArticleDetailComments articleId={article.id} userId={article.user.id} />
          )}
        </Stack>
      </Container>
    </>
  );
}
