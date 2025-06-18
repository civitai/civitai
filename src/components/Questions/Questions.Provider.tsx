import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import {
  Popover,
  ActionIcon,
  Stack,
  Indicator,
  Chip,
  Badge,
  Center,
  Group,
  Loader,
  Pagination,
  Paper,
  ThemeIcon,
  Title,
  Text,
  useComputedColorScheme,
} from '@mantine/core';
import { IconCloudOff, IconFilter, IconHeart, IconMessageCircle } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import router, { useRouter } from 'next/router';
import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { constants } from '~/server/common/constants';
import { QuestionSort, QuestionStatus } from '~/server/common/enums';
import { QS } from '~/utils/qs';
import { slugit, splitUppercase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { containerQuery } from '~/utils/mantine-css-helpers';
import classes from './Questions.Provider.module.scss';
import { LegacyActionIcon } from '../LegacyActionIcon/LegacyActionIcon';

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
          size={16}
          zIndex={10}
          disabled={!filterLength}
          inline
        >
          <LegacyActionIcon color="dark" variant="transparent">
            <IconFilter size={24} />
          </LegacyActionIcon>
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
              <span>{splitUppercase(value)}</span>
            </Chip>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function QuestionsList() {
  const filters = useQuestionFilters();
  const colorScheme = useComputedColorScheme('dark');

  const { data: questions, isLoading } = trpc.question.getPaged.useQuery(filters);

  return isLoading ? (
    <Center>
      <Loader size="xl" />
    </Center>
  ) : !!questions?.items.length ? (
    <Stack gap="sm">
      {questions.items.map((question) => (
        <Link
          key={question.id}
          href={`/questions/${question.id}/${slugit(question.title)}`}
          passHref
        >
          <Paper withBorder p="sm">
            <Stack gap="xs">
              <Title order={3} className={classes.title}>
                {question.title}
              </Title>
              <Group justify="space-between" gap="sm">
                <Group gap={4}>
                  {question.tags.map((tag, index) => (
                    <Badge key={index} size="xs">
                      {tag.name}
                    </Badge>
                  ))}
                </Group>
                <Group gap={4}>
                  <Badge
                    variant={colorScheme === 'dark' ? 'light' : 'filled'}
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
                    variant={colorScheme === 'dark' ? 'light' : 'filled'}
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
        </Link>
      ))}
      {questions.totalPages > 1 && (
        <Group justify="space-between">
          <Text>Total {questions.totalItems} items</Text>

          <Pagination
            value={filters.page}
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
      <Text fz={32} align="center">
        No results found
      </Text>
      <Text align="center">
        {"Try adjusting your search or filters to find what you're looking for"}
      </Text>
    </Stack>
  );
}

Questions.Sort = QuestionsSort;
Questions.Period = QuestionsPeriod;
Questions.Filter = QuestionsFilter;
Questions.List = QuestionsList;
