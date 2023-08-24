import { MetricTimeframe } from '@prisma/client';
import {
  Popover,
  ActionIcon,
  Stack,
  Indicator,
  Chip,
  Badge,
  Center,
  createStyles,
  Group,
  Loader,
  Pagination,
  Paper,
  ThemeIcon,
  Title,
  Text,
} from '@mantine/core';
import { IconCloudOff, IconFilter, IconHeart, IconMessageCircle } from '@tabler/icons-react';
import Link from 'next/link';
import router, { useRouter } from 'next/router';
import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { constants } from '~/server/common/constants';
import { QuestionSort, QuestionStatus } from '~/server/common/enums';
import { QS } from '~/utils/qs';
import { slugit, splitUppercase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { useFiltersContext } from '~/providers/FiltersProvider';

export function Questions({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

const useQuestionFilters = () => {
  const router = useRouter();
  const page = router.query.page ? Number(router.query.page) : 1;
  const limit = constants.questionFilterDefaults.limit;
  const filters = useFiltersContext((state) => state.questions);
  return { ...filters, page, limit };
};

const sortOptions = Object.values(QuestionSort);
function QuestionsSort() {
  const setSort = useFiltersContext((state) => state.setQuestionFilters);
  const sort = useFiltersContext((state) => state.questions.sort);

  return (
    <SelectMenu
      label={sort}
      options={sortOptions.map((x) => ({ label: x, value: x }))}
      onClick={(sort) => setSort({ sort })}
      value={sort}
    />
  );
}

const periodOptions = Object.values(MetricTimeframe);
function QuestionsPeriod() {
  const setPeriod = useFiltersContext((state) => state.setQuestionFilters);
  const period = useFiltersContext((state) => state.questions.period);

  return (
    <SelectMenu
      label={period && splitUppercase(period.toString())}
      options={periodOptions.map((option) => ({ label: splitUppercase(option), value: option }))}
      onClick={(period) => setPeriod({ period })}
      value={period}
    />
  );
}

function QuestionsFilter() {
  const setStatus = useFiltersContext((state) => state.setQuestionFilters);
  const status = useFiltersContext((state) => state.questions.status);

  const filterLength = !!status ? 1 : 0;

  return (
    <Popover withArrow>
      <Popover.Target>
        <Indicator
          offset={4}
          label={filterLength ? filterLength : undefined}
          showZero={false}
          dot={false}
          size={16}
          inline
          zIndex={10}
        >
          <ActionIcon color="dark" variant="transparent">
            <IconFilter size={24} />
          </ActionIcon>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack>
          {Object.values(QuestionStatus).map((value, index) => (
            <Chip
              key={index}
              value={value}
              styles={{ label: { width: '100%', textAlign: 'center' } }}
              checked={status === value}
              onChange={(checked) => setStatus({ status: checked ? value : undefined })}
            >
              {splitUppercase(value)}
            </Chip>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function QuestionsList() {
  const { classes, theme } = useStyles();
  const filters = useQuestionFilters();

  const { data: questions, isLoading } = trpc.question.getPaged.useQuery(filters);

  return isLoading ? (
    <Center>
      <Loader size="xl" />
    </Center>
  ) : !!questions?.items.length ? (
    <Stack spacing="sm">
      {questions.items.map((question) => (
        <Link
          key={question.id}
          href={`/questions/${question.id}/${slugit(question.title)}`}
          passHref
        >
          <a>
            <Paper withBorder p="sm">
              <Stack spacing="xs">
                <Title order={3} className={classes.title}>
                  {question.title}
                </Title>
                <Group position="apart" spacing="sm">
                  <Group spacing={4}>
                    {question.tags.map((tag, index) => (
                      <Badge key={index} size="xs">
                        {tag.name}
                      </Badge>
                    ))}
                  </Group>
                  <Group spacing={4}>
                    <Badge
                      variant={theme.colorScheme === 'dark' ? 'light' : 'filled'}
                      color={question.rank.heartCount ? 'pink' : 'gray'}
                      size="xs"
                      leftSection={
                        <Center>
                          <IconHeart size={14} />
                        </Center>
                      }
                    >
                      {question.rank.heartCount}
                    </Badge>
                    <Badge
                      variant={theme.colorScheme === 'dark' ? 'light' : 'filled'}
                      color={question.selectedAnswerId ? 'green' : 'gray'}
                      size="xs"
                      leftSection={
                        <Center>
                          <IconMessageCircle size={14} />
                        </Center>
                      }
                    >
                      {question.rank.answerCount}
                    </Badge>
                  </Group>
                </Group>
              </Stack>
            </Paper>
          </a>
        </Link>
      ))}
      {questions.totalPages > 1 && (
        <Group position="apart">
          <Text>Total {questions.totalItems} items</Text>

          <Pagination
            page={filters.page}
            onChange={(page) => {
              const [pathname, query] = router.asPath.split('?');
              router.push({ pathname, query: { ...QS.parse(query), page } }, undefined, {
                shallow: true,
              });
            }}
            total={questions.totalPages}
          />
        </Group>
      )}
    </Stack>
  ) : (
    <Stack align="center">
      <ThemeIcon size={128} radius={100}>
        <IconCloudOff size={80} />
      </ThemeIcon>
      <Text size={32} align="center">
        No results found
      </Text>
      <Text align="center">
        {"Try adjusting your search or filters to find what you're looking for"}
      </Text>
    </Stack>
  );
}

const useStyles = createStyles((theme) => ({
  title: {
    overflowWrap: 'break-word',

    [`@media(max-width: ${theme.breakpoints.sm}px)`]: {
      fontSize: 16,
    },
  },
}));

Questions.Sort = QuestionsSort;
Questions.Period = QuestionsPeriod;
Questions.Filter = QuestionsFilter;
Questions.List = QuestionsList;
