import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Group,
  NumberInput,
  Paper,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { Menu } from '~/components/MantineOverlays';
import type { ServiceFormQuestion, ServiceRequestForm } from '~/shared/utils/service-request-form';
import {
  SERVICE_FORM_LABEL_MAX,
  SERVICE_FORM_OPTIONS_MAX,
  SERVICE_FORM_QUANTITY_MAX,
  SERVICE_FORM_QUESTIONS_MAX,
  serviceFormRange,
  serviceFormRangeError,
} from '~/shared/utils/service-request-form';
import {
  SERVICE_DELIVERY_DAYS_MAX,
  SERVICE_PRICE_MAX,
} from '~/shared/constants/creator-service.constants';

type QuestionType = ServiceFormQuestion['type'];
type Option = { id: string; label: string; price: number; days: number };

const TYPE_LABELS: Record<QuestionType, string> = {
  pickOne: 'Pick one',
  pickAny: 'Pick any',
  number: 'Number',
  text: 'Text',
};

const newId = () => Math.random().toString(36).slice(2, 10);
const newOption = (label = ''): Option => ({ id: newId(), label, price: 0, days: 0 });

export function newServiceFormQuestion(type: QuestionType): ServiceFormQuestion {
  const id = newId();
  if (type === 'pickOne')
    return { type, id, label: '', options: [newOption('Standard'), newOption('Premium')] };
  if (type === 'pickAny') return { type, id, label: '', options: [newOption()] };
  if (type === 'number')
    return { type, id, label: '', min: 1, max: 4, included: 1, price: 0, days: 0 };
  return { type, id, label: '', required: true };
}

const toInt = (value: string | number, fallback = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;

/**
 * The seller's request form: questions whose answers add Buzz and days to the base price. Shows the
 * "from" price buyers will see and why a form cannot be saved, from the same function the server
 * checks with.
 */
export function ServiceRequestFormEditor({
  value,
  onChange,
  base,
}: {
  value: ServiceRequestForm;
  onChange: (form: ServiceRequestForm) => void;
  base: { price: number; deliveryDays: number };
}) {
  const setQuestion = (index: number, question: ServiceFormQuestion) =>
    onChange({ questions: value.questions.map((q, i) => (i === index ? question : q)) });
  const removeQuestion = (index: number) =>
    onChange({ questions: value.questions.filter((_, i) => i !== index) });
  const range = serviceFormRange(value, base);
  const error = serviceFormRangeError(value, base);

  return (
    <Stack gap="sm">
      {value.questions.map((question, index) => (
        <Paper key={question.id} withBorder p="sm" radius="md">
          <Stack gap="xs">
            <Group gap="xs" wrap="nowrap">
              <Badge variant="light" className="shrink-0">
                {TYPE_LABELS[question.type]}
              </Badge>
              <TextInput
                className="flex-1"
                placeholder="Question"
                aria-label="Question"
                value={question.label}
                maxLength={SERVICE_FORM_LABEL_MAX}
                onChange={(e) => setQuestion(index, { ...question, label: e.currentTarget.value })}
              />
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label="Remove question"
                onClick={() => removeQuestion(index)}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Group>
            <QuestionDetails question={question} onChange={(next) => setQuestion(index, next)} />
          </Stack>
        </Paper>
      ))}
      <Group justify="space-between" align="flex-start">
        <Menu position="bottom-start">
          <Menu.Target>
            <Button
              variant="light"
              size="xs"
              leftSection={<IconPlus size={14} />}
              disabled={value.questions.length >= SERVICE_FORM_QUESTIONS_MAX}
            >
              Add question
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            {(Object.keys(TYPE_LABELS) as QuestionType[]).map((type) => (
              <Menu.Item
                key={type}
                onClick={() =>
                  onChange({ questions: [...value.questions, newServiceFormQuestion(type)] })
                }
              >
                {TYPE_LABELS[type]}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
        <Text size="xs" c="dimmed" ta="right">
          Buyers see “from {range.minPrice.toLocaleString()} Buzz”. Highest total:{' '}
          {range.maxPrice.toLocaleString()} Buzz, {range.maxDays} days.
        </Text>
      </Group>
      {error && (
        <Text size="sm" c="red">
          {error}
        </Text>
      )}
    </Stack>
  );
}

function QuestionDetails({
  question,
  onChange,
}: {
  question: ServiceFormQuestion;
  onChange: (question: ServiceFormQuestion) => void;
}) {
  if (question.type === 'text')
    return (
      <Checkbox
        label="Required"
        checked={question.required}
        onChange={(e) => onChange({ ...question, required: e.currentTarget.checked })}
      />
    );
  if (question.type === 'number')
    return (
      <Group gap="xs" grow>
        <NumberInput
          label="Smallest"
          min={0}
          max={SERVICE_FORM_QUANTITY_MAX}
          value={question.min}
          onChange={(v) => onChange({ ...question, min: toInt(v) })}
        />
        <NumberInput
          label="Largest"
          min={1}
          max={SERVICE_FORM_QUANTITY_MAX}
          value={question.max}
          onChange={(v) => onChange({ ...question, max: toInt(v, 1) })}
        />
        <NumberInput
          label="Included"
          min={0}
          max={SERVICE_FORM_QUANTITY_MAX}
          value={question.included}
          onChange={(v) => onChange({ ...question, included: toInt(v) })}
        />
        <NumberInput
          label="+Buzz each extra"
          min={0}
          max={SERVICE_PRICE_MAX}
          step={100}
          value={question.price}
          onChange={(v) => onChange({ ...question, price: toInt(v) })}
        />
        <NumberInput
          label="+Days each extra"
          min={0}
          max={SERVICE_DELIVERY_DAYS_MAX}
          value={question.days}
          onChange={(v) => onChange({ ...question, days: toInt(v) })}
        />
      </Group>
    );

  const setOption = (index: number, option: Option) =>
    onChange({ ...question, options: question.options.map((o, i) => (i === index ? option : o)) });
  const minOptions = question.type === 'pickOne' ? 2 : 1;
  return (
    <Stack gap={6}>
      {question.options.map((option, index) => (
        <Group key={option.id} gap="xs" wrap="nowrap">
          <TextInput
            className="flex-1"
            placeholder="Option"
            aria-label="Option"
            value={option.label}
            maxLength={SERVICE_FORM_LABEL_MAX}
            onChange={(e) => setOption(index, { ...option, label: e.currentTarget.value })}
          />
          <NumberInput
            className="w-28"
            aria-label="Adds Buzz"
            leftSection={<Text size="xs">+⚡</Text>}
            min={0}
            max={SERVICE_PRICE_MAX}
            step={100}
            value={option.price}
            onChange={(v) => setOption(index, { ...option, price: toInt(v) })}
          />
          <NumberInput
            className="w-24"
            aria-label="Adds days"
            rightSection={<Text size="xs">d</Text>}
            min={0}
            max={SERVICE_DELIVERY_DAYS_MAX}
            value={option.days}
            onChange={(v) => setOption(index, { ...option, days: toInt(v) })}
          />
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label="Remove option"
            disabled={question.options.length <= minOptions}
            onClick={() =>
              onChange({ ...question, options: question.options.filter((_, i) => i !== index) })
            }
          >
            <IconTrash size={14} />
          </ActionIcon>
        </Group>
      ))}
      <Button
        variant="subtle"
        size="compact-xs"
        className="self-start"
        leftSection={<IconPlus size={12} />}
        disabled={question.options.length >= SERVICE_FORM_OPTIONS_MAX}
        onClick={() => onChange({ ...question, options: [...question.options, newOption()] })}
      >
        Add option
      </Button>
    </Stack>
  );
}
