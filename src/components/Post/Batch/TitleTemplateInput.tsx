import { Text, TextInput } from '@mantine/core';
import { TITLE_TOKENS } from './batch-composer.utils';

export function TitleTemplateInput({
  value,
  onChange,
  previews,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  previews: string[];
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <TextInput
        label="Title"
        placeholder="Leave empty for untitled posts"
        description={`Tokens: {n} post number, {total}, {model}, {version}, {date}.`}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        disabled={disabled}
        maxLength={255}
        data-testid="batch-title-template"
      />
      <div className="flex flex-wrap gap-1">
        {TITLE_TOKENS.map((token) => (
          <button
            key={token}
            type="button"
            disabled={disabled}
            onClick={() => onChange(`${value}${value && !value.endsWith(' ') ? ' ' : ''}${token}`)}
            className="font-mono rounded bg-gray-1 px-1.5 py-0.5 text-xs text-dark-6 hover:bg-gray-2 disabled:opacity-50 dark:bg-dark-5 dark:text-gray-3 dark:hover:bg-dark-4"
          >
            {token}
          </button>
        ))}
      </div>
      {previews.length > 0 && (
        <Text size="sm" c="dimmed">
          Preview: {previews.map((title) => `“${title}”`).join(', ')}
          {previews.length > 1 ? ', …' : ''}
        </Text>
      )}
    </div>
  );
}
