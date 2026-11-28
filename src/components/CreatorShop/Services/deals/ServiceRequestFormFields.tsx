import { Checkbox, Group, NumberInput, Paper, Radio, Stack, Text, Textarea } from '@mantine/core';
import type {
  ServiceFormAnswers,
  ServiceFormPrice,
  ServiceRequestForm,
} from '~/shared/utils/service-request-form';
import { SERVICE_FORM_ANSWER_MAX } from '~/shared/utils/service-request-form';

/** Answers a buyer starts from: the first option of each pick-one, the smallest of each number. */
export function initialServiceFormAnswers(form: ServiceRequestForm): ServiceFormAnswers {
  return Object.fromEntries(
    form.questions.flatMap((question): [string, string | number][] =>
      question.type === 'pickOne'
        ? [[question.id, question.options[0].id]]
        : question.type === 'number'
        ? [[question.id, question.min]]
        : []
    )
  );
}

const adds = ({ price, days }: { price: number; days: number }) =>
  [price ? `+⚡${price.toLocaleString()}` : '', days ? `+${days}d` : '']
    .filter(Boolean)
    .join(' · ');

/** The seller's questions, and the total the answers give, line by line. */
export function ServiceRequestFormFields({
  form,
  answers,
  onChange,
  priced,
}: {
  form: ServiceRequestForm;
  answers: ServiceFormAnswers;
  onChange: (answers: ServiceFormAnswers) => void;
  priced: ServiceFormPrice;
}) {
  const set = (id: string, value: ServiceFormAnswers[string] | undefined) => {
    const next = { ...answers };
    if (value === undefined) delete next[id];
    else next[id] = value;
    onChange(next);
  };

  return (
    <Stack gap="md">
      {form.questions.map((question) => {
        const answer = answers[question.id];
        if (question.type === 'pickOne')
          return (
            <Radio.Group
              key={question.id}
              label={question.label}
              value={typeof answer === 'string' ? answer : null}
              onChange={(value) => set(question.id, value)}
              withAsterisk
            >
              <Stack gap={6} mt={6}>
                {question.options.map((option) => (
                  <Radio
                    key={option.id}
                    value={option.id}
                    label={
                      <Group gap={6}>
                        <span>{option.label}</span>
                        <Text span size="xs" c="yellow.6" fw={700}>
                          {adds(option)}
                        </Text>
                      </Group>
                    }
                  />
                ))}
              </Stack>
            </Radio.Group>
          );
        if (question.type === 'pickAny')
          return (
            <Checkbox.Group
              key={question.id}
              label={question.label}
              value={Array.isArray(answer) ? answer : []}
              onChange={(value) => set(question.id, value.length ? value : undefined)}
            >
              <Stack gap={6} mt={6}>
                {question.options.map((option) => (
                  <Checkbox
                    key={option.id}
                    value={option.id}
                    label={
                      <Group gap={6}>
                        <span>{option.label}</span>
                        <Text span size="xs" c="yellow.6" fw={700}>
                          {adds(option)}
                        </Text>
                      </Group>
                    }
                  />
                ))}
              </Stack>
            </Checkbox.Group>
          );
        if (question.type === 'number')
          return (
            <NumberInput
              key={question.id}
              label={question.label}
              description={
                [
                  question.included ? `${question.included} included` : '',
                  adds(question) && `${adds(question)} each extra`,
                ]
                  .filter(Boolean)
                  .join(' · ') || undefined
              }
              min={question.min}
              max={question.max}
              allowDecimal={false}
              clampBehavior="strict"
              value={typeof answer === 'number' ? answer : question.min}
              onChange={(value) => set(question.id, typeof value === 'number' ? value : undefined)}
              withAsterisk
            />
          );
        return (
          <Textarea
            key={question.id}
            label={question.label}
            value={typeof answer === 'string' ? answer : ''}
            onChange={(e) => set(question.id, e.currentTarget.value || undefined)}
            autosize
            minRows={2}
            maxLength={SERVICE_FORM_ANSWER_MAX}
            withAsterisk={question.required}
          />
        );
      })}
      {priced.ok ? (
        <Paper withBorder p="sm" radius="md">
          <Stack gap={4}>
            {priced.breakdown.map((line, index) => (
              <Group key={index} justify="space-between" gap="xs">
                <Text size="sm" c="dimmed">
                  {line.label}
                </Text>
                <Text size="sm">{line.price.toLocaleString()}</Text>
              </Group>
            ))}
            <Group justify="space-between" gap="xs">
              <Text size="sm" fw={700}>
                Total · ~{priced.deliveryDays} days
              </Text>
              <Text size="sm" fw={700} c="yellow.6">
                ⚡ {priced.price.toLocaleString()}
              </Text>
            </Group>
          </Stack>
        </Paper>
      ) : (
        <Text size="sm" c="dimmed">
          {priced.error}
        </Text>
      )}
    </Stack>
  );
}
