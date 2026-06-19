import { Button, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconDeviceMobile } from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatUserCode, isUserCodeComplete } from '~/server/oauth/user-code';

export interface DeviceCodeEntryProps {
  /** Initial value (e.g. prefilled from `?code=` on the verification URL). */
  initialCode?: string;
  /** Whether the lookup mutation is in flight (drives the button spinner). */
  loading?: boolean;
  /** Username to show in the "Signed in as" footer. */
  username?: string;
  /**
   * Invoked with the canonical, hyphen-formatted code (`XXXX-XXXX`) when the
   * user submits — via the primary button, Enter, or auto-submit on a complete
   * value. The parent owns the actual lookup; this component only decides *when*
   * to fire and guards against double-submits.
   */
  onSubmit: (code: string) => void;
}

/**
 * Code-entry step of the OAuth device flow. Lifts the "when to submit" UX out of
 * the page so it's unit-testable in isolation:
 *  - Enter while the field is focused submits (no-op if the code is incomplete).
 *  - A COMPLETE code (typed or pasted) auto-submits without Enter/click.
 *  - Double-submit guarded: a value only auto-submits ONCE; Enter on an
 *    already-auto-submitted value is a no-op; an in-flight submit can't re-fire.
 *  - Editing the field after a submit re-arms it, so a failed/expired code can
 *    be corrected and re-submitted.
 *
 * Completeness + canonical formatting come from `~/server/oauth/user-code` (the
 * same module the server generator uses) — the full length isn't hardcoded here.
 */
export function DeviceCodeEntry({
  initialCode = '',
  loading = false,
  username,
  onSubmit,
}: DeviceCodeEntryProps) {
  const [code, setCode] = useState(initialCode);

  // Focus the input on mount so the user can paste/type the code immediately
  // without clicking. A ref + one-shot effect (rather than the `autoFocus`
  // prop) keeps focus deterministic and assertable, and runs once — it does not
  // re-run on the auto-submit / loading re-renders, so it can't fight the
  // auto-submit-on-completeness or Enter logic.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // The exact value we last fired `onSubmit` for. We only auto-submit / accept
  // Enter once per distinct complete value; editing to a different value
  // (including correcting a bad code) clears this and re-arms submission. A
  // ref (not state) so updating it never triggers a render → no auto-submit loop.
  const lastSubmittedRef = useRef<string | null>(null);

  const submit = useCallback(
    (raw: string) => {
      const formatted = formatUserCode(raw);
      // Guards: incomplete → no-op (matches the existing validation, which just
      // disables the button); already submitted this exact value → no-op
      // (Enter-after-autosubmit, re-render with a complete value); in-flight →
      // no-op (can't stack a second lookup on top of a running one).
      if (!isUserCodeComplete(formatted)) return;
      if (lastSubmittedRef.current === formatted) return;
      if (loading) return;
      lastSubmittedRef.current = formatted;
      onSubmit(formatted);
    },
    [loading, onSubmit]
  );

  const handleChange = useCallback(
    (value: string) => {
      setCode(value);
      // If the user edited to a value different from the one we last submitted,
      // re-arm: a corrected/expired code must be submittable again.
      if (lastSubmittedRef.current !== null && formatUserCode(value) !== lastSubmittedRef.current) {
        lastSubmittedRef.current = null;
      }
    },
    []
  );

  // Auto-submit on completeness (covers paste — paste fires onChange — and
  // typing reaching full length). Runs after the `code` state commits so the
  // guard in `submit` sees the latest value. The `lastSubmittedRef` guard makes
  // a re-render with an already-complete value a no-op (no loop).
  useEffect(() => {
    if (isUserCodeComplete(code)) {
      submit(code);
    }
    // `submit` is stable except when `loading` flips; when loading clears we do
    // NOT want to re-fire (lastSubmittedRef already holds this value), so the
    // ref guard covers it. Depending on `code` + `submit` is correct here.
  }, [code, submit]);

  return (
    <>
      <IconDeviceMobile size={48} />
      <Title order={3}>Connect a Device</Title>
      <Text c="dimmed" ta="center">
        Enter the code shown on your device to authorize it with your Civitai account.
      </Text>
      <TextInput
        ref={inputRef}
        aria-label="Device code"
        value={code}
        onChange={(e) => handleChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit(code);
          }
        }}
        placeholder="XXXX-XXXX"
        size="lg"
        w="100%"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        styles={{
          input: { textAlign: 'center', letterSpacing: '0.15em', fontWeight: 600 },
        }}
      />
      <Button
        fullWidth
        onClick={() => submit(code)}
        loading={loading}
        disabled={!isUserCodeComplete(code)}
      >
        Continue
      </Button>
      {username && (
        <Text size="xs" c="dimmed" ta="center">
          Signed in as {username}
        </Text>
      )}
    </>
  );
}
