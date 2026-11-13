// Approved copy for the non-commercial earnings notices: change it only with sign-off.
// Per send: `{username}`, `{date}`, `{baseModels}` (the creator's own affected base models) and
// `{versions}` (their versions that had a fee). `{x|y}` is singular|plural by how many base models
// the creator has. A `[fee] ` line goes only to creators who had a fee, without the marker.

export type NcEarningsNotice = 'nc-recent' | 'nc-older';

/** The notification links to the creator's own models list; the email carries the detail. */
export const getNcEarningsNoticeUrl = (username: string | null) =>
  username ? `/user/${encodeURIComponent(username)}/models` : '/user/account';

export const NC_EARNINGS_NOTICE: Record<
  NcEarningsNotice,
  {
    baseModels: string[];
    subject: string;
    message: string;
    /** The notification for a creator who had a fee; `message` when absent. */
    feeMessage?: string;
    markdown: string;
  }
> = {
  'nc-recent': {
    baseModels: ['Flux.3 Klein', 'Flux.3 Klein-base', 'Ideogram 4.0', 'Qwen 2.1'],
    subject: 'Generation earnings have stopped on your {baseModels} models',
    message:
      '{baseModels} {is|are} licensed for non-commercial use only, so generation earnings (creator compensation and tips) have stopped for your models on {it|them}. They stay published and free to use.',
    markdown: `Hi {username},

{baseModels} {is|are} released under {a license|licenses} that allow{s|} non-commercial use only, which doesn't allow earning from models built on {it|them}. As of {date}:

- **Generation earnings stop** for your versions on {baseModels}: no more creator compensation or tips from generations that use them.
- **Your models stay published** and free for everyone to download and use. You don't need to do anything.
- **Buzz you've already earned stays with you.**
- **You can't add a generation fee or paid access** to these versions, and they can't be promoted in model auctions.

If you'd rather not offer a model without earnings, you can unpublish it from its edit page.

If you have questions, reply to this message.

The Civitai Team`,
  },
  'nc-older': {
    baseModels: ['Flux.1 Krea', 'Flux.1 Kontext', 'Flux.2 D', 'Stable Cascade'],
    subject: 'Generation earnings have stopped on your {baseModels} models',
    message:
      '{baseModels} {is|are} licensed for non-commercial use only, so generation earnings (creator compensation and tips) have stopped for your models on {it|them}. They stay published and free to use.',
    feeMessage:
      '{baseModels} {is|are} licensed for non-commercial use only, so generation fees and earnings (creator compensation and tips) have stopped for your models on {it|them}. They stay published and free to use.',
    markdown: `Hi {username},

{baseModels} {is|are} released under {a license|licenses} that allow{s|} non-commercial use only, which doesn't allow earning from models built on {it|them}. As of {date}:

- **Generation earnings stop** for your versions on {baseModels}: no more creator compensation or tips from generations that use them.
- [fee] **Your generation fee is no longer charged** on these versions: {versions}.
- **Your models stay published** and free for everyone to download and use. You don't need to do anything.
- **Buzz you've already earned stays with you.**
- **You can't add a generation fee or paid access** to these versions, and they can't be promoted in model auctions.

If you'd rather not offer a model without earnings, you can unpublish it from its edit page.

If you have questions, reply to this message.

The Civitai Team`,
  },
};

const PLURAL = /\{([^{}|]*)\|([^{}|]*)\}/g;

/** Leaves {username}, {date} and {versions} for the caller to fill after markdown rendering. */
export function fillNcEarningsCopy(text: string, baseModels: string[], hadFee: boolean) {
  const joined = new Intl.ListFormat('en', { type: 'conjunction' }).format(baseModels);
  return text
    .split('\n')
    .filter((line) => hadFee || !line.startsWith('- [fee] '))
    .map((line) => line.replace('- [fee] ', '- '))
    .join('\n')
    .replace(PLURAL, (_, one: string, many: string) => (baseModels.length === 1 ? one : many))
    .replace(/\{baseModels\}/g, () => joined);
}
