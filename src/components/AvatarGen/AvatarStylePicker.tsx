import { Input, Modal, SegmentedControl, Tabs, Text, UnstyledButton } from '@mantine/core';
import { IconCheck, IconChevronRight } from '@tabler/icons-react';
import clsx from 'clsx';
import { useLocalStorage } from '@mantine/hooks';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import {
  avatarStarterCharacters,
  avatarStyleCharacterSrc,
  avatarStyleCoverSrc,
} from '~/shared/constants/avatar-starters';
import {
  avatarCategories,
  avatarStyleByKey,
  avatarStyles,
} from '~/shared/constants/avatar-styles.constants';

const characterOptions = avatarStarterCharacters.map((character) => ({
  value: character,
  label: character[0].toUpperCase() + character.slice(1),
}));

function StyleCover({
  styleKey,
  character,
  className,
}: {
  styleKey: string;
  character?: string;
  className?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={character ? avatarStyleCharacterSrc(styleKey, character) : avatarStyleCoverSrc(styleKey)}
      alt={avatarStyleByKey.get(styleKey)?.name ?? ''}
      loading="lazy"
      className={clsx('aspect-square object-cover', className)}
    />
  );
}

export function AvatarStylePicker({
  value,
  onChange,
}: {
  value?: string;
  onChange: (styleKey: string) => void;
}) {
  const style = value ? avatarStyleByKey.get(value) : undefined;

  const openPicker = () =>
    dialogStore.trigger({
      id: 'avatar-style-picker',
      component: AvatarStyleModal,
      props: { value, onSelect: onChange },
    });

  return (
    <Input.Wrapper label="Style">
      <UnstyledButton
        onClick={openPicker}
        className="flex w-full items-center gap-3 rounded-md border border-gray-4 bg-gray-0 p-2 transition-colors hover:border-blue-5 hover:bg-gray-1 dark:border-dark-3 dark:bg-dark-6 dark:hover:border-blue-7 dark:hover:bg-dark-5"
      >
        {style && <StyleCover styleKey={style.key} className="size-14 rounded" />}
        <div className="min-w-0 flex-1">
          <Text size="sm" fw={500}>
            {style?.name ?? 'Choose a style'}
          </Text>
          <Text size="xs" c="dimmed">
            {style?.category ?? `${avatarStyles.length} styles`}
          </Text>
        </div>
        <span className="flex items-center gap-0.5 text-xs font-medium text-blue-6 dark:text-blue-4">
          Change
          <IconChevronRight size={16} />
        </span>
      </UnstyledButton>
    </Input.Wrapper>
  );
}

/** Centres the current style in its scroll panel; it can sit far below the first row. */
function scrollIntoPanel(element: HTMLElement | null) {
  const panel = element?.parentElement;
  if (!element || !panel) return;
  panel.scrollTop =
    element.offsetTop - panel.offsetTop - (panel.clientHeight - element.clientHeight) / 2;
}

function AvatarStyleModal({
  value,
  onSelect,
}: {
  value?: string;
  onSelect: (styleKey: string) => void;
}) {
  const dialog = useDialogContext();
  const [storedCharacter, setCharacter] = useLocalStorage<string>({
    key: 'avatar-style-preview-character',
    defaultValue: avatarStarterCharacters[0],
  });
  // A cast change can leave a stored name with no images.
  const character = (avatarStarterCharacters as readonly string[]).includes(storedCharacter)
    ? storedCharacter
    : avatarStarterCharacters[0];
  const currentCategory = value ? avatarStyleByKey.get(value)?.category : undefined;

  return (
    <Modal {...dialog} title="Choose a style" size="xl" yOffset="6vh">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Text size="sm" c="dimmed">
          Preview as
        </Text>
        <SegmentedControl
          size="xs"
          value={character}
          onChange={setCharacter}
          data={characterOptions}
        />
      </div>
      <Tabs defaultValue={currentCategory ?? avatarCategories[0]}>
        <Tabs.List className="mb-3">
          {avatarCategories.map((category) => (
            <Tabs.Tab
              key={category}
              value={category}
              rightSection={
                category === currentCategory ? (
                  <span className="size-2 rounded-full bg-blue-6" aria-label="Selected style" />
                ) : undefined
              }
            >
              {category}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {avatarCategories.map((category) => (
          <Tabs.Panel key={category} value={category}>
            <div
              className="grid h-[70vh] auto-rows-min grid-cols-2 gap-3 overflow-y-auto p-2 sm:grid-cols-4"
              role="radiogroup"
            >
              {avatarStyles
                .filter((style) => style.category === category)
                .map((style) => {
                  const isSelected = style.key === value;
                  return (
                    <UnstyledButton
                      key={style.key}
                      role="radio"
                      aria-checked={isSelected}
                      ref={isSelected ? scrollIntoPanel : undefined}
                      onClick={() => {
                        onSelect(style.key);
                        dialog.onClose();
                      }}
                      className={clsx(
                        'relative flex flex-col overflow-hidden rounded-md text-left transition-shadow',
                        isSelected
                          ? 'ring-4 ring-blue-5 ring-offset-2 dark:ring-offset-dark-7'
                          : 'ring-1 ring-transparent hover:ring-gray-4 dark:hover:ring-dark-3'
                      )}
                    >
                      <StyleCover styleKey={style.key} character={character} className="w-full" />
                      {isSelected && (
                        <span className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded-full bg-blue-6 py-0.5 pl-1 pr-2 text-xs font-medium text-white">
                          <IconCheck size={12} />
                          Selected
                        </span>
                      )}
                      <span
                        className={clsx(
                          'truncate px-2 py-1.5 text-sm font-medium',
                          isSelected && 'text-blue-6 dark:text-blue-4'
                        )}
                      >
                        {style.name}
                      </span>
                    </UnstyledButton>
                  );
                })}
            </div>
          </Tabs.Panel>
        ))}
      </Tabs>
    </Modal>
  );
}
