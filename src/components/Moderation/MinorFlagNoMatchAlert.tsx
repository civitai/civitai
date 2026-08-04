import { Alert, Text } from '@mantine/core';

// A moderator's own Set-as-Minor never had a hash match, so the auto copy's
// "the evidence has since vanished" invents a reason to doubt a decision that
// was made without hashes in the first place.
export function MinorFlagNoMatchAlert({ flagSource }: { flagSource?: string | null }) {
  if (flagSource === 'manual')
    return (
      <Alert color="blue" title="No hash match">
        <Text size="sm">
          A moderator flagged this model directly rather than the automation matching it against a
          known minor model, so there is no match to show — nothing is missing here.
        </Text>
      </Alert>
    );

  return (
    <Alert color="yellow" title="No matching flagged model">
      <Text size="sm">
        Nothing a moderator has flagged minor still shares a file with this model. The match is
        resolved live, so this means the model it matched has since been unflagged or its hashes
        were permanently deleted — worth checking before you keep the flag.
      </Text>
    </Alert>
  );
}
