// Approved copy for the Flux.2 Klein 9B creator notices: change it only with sign-off.
// `{username}` and `{date}` are filled per send; `{versions}` (charged only) becomes a list of the
// creator's charged versions.

export type Klein9bNoticeVariant = 'charged' | 'uncharged';

export const KLEIN9B_NOTICE_BASE_MODELS = ['Flux.2 Klein 9B', 'Flux.2 Klein 9B-base'];

export const getKlein9bNoticeUrl = (username: string | null) =>
  username ? `/user/${encodeURIComponent(username)}/models` : '/user/account';

export const KLEIN9B_NOTICE: Record<
  Klein9bNoticeVariant,
  { subject: string; message: string; markdown: string }
> = {
  charged: {
    subject: 'Your paid Flux.2 Klein 9B models are no longer for sale',
    message:
      'Flux.2 Klein 9B is licensed for non-commercial use only, so your paid Flux.2 Klein 9B versions can no longer be bought or charge a generation fee. You can make them free, unpublish them, or leave them as they are.',
    markdown: `Hi {username},

Flux.2 Klein 9B and Flux.2 Klein 9B-base are released by Black Forest Labs under the FLUX Non-Commercial License v2.1, which doesn't allow charging for models built on them. As of {date}, here's what has changed for your versions on these base models:

{versions}

- **They stay listed.** Nothing was unpublished or deleted, and your settings are unchanged.
- **New purchases are turned off.** Anyone who tries to buy access sees "Not commercially available at the moment."
- **No generation fee is charged**, and generation earnings (creator compensation and tips) stop for these versions.
- **People who already bought access keep it.**
- **Buzz you've already earned stays with you**, and so do donations already made.

You can choose what to do next:
1. **Make it free:** open the version's edit page, turn off paid access and the generation fee, and save.
2. **Unpublish it**, if you'd rather it not be available for free.
3. **Leave it as it is.** It stays listed but can't be bought.

If you have questions, reply to this message.

The Civitai Team`,
  },
  uncharged: {
    subject: 'Generation earnings have stopped on your Flux.2 Klein 9B models',
    message:
      'Flux.2 Klein 9B is licensed for non-commercial use only, so generation earnings (creator compensation and tips) have stopped for your Flux.2 Klein 9B models. They stay published and free to use.',
    markdown: `Hi {username},

Flux.2 Klein 9B and Flux.2 Klein 9B-base are released by Black Forest Labs under the FLUX Non-Commercial License v2.1, which doesn't allow earning from models built on them. As of {date}:

- **Generation earnings stop** for your versions on these base models: no more creator compensation or tips from generations that use them.
- **Your models stay published** and free for everyone to download and use. You don't need to do anything.
- **Buzz you've already earned stays with you.**
- **You can't add a generation fee or paid access** to these versions.

If you'd rather not offer a model without earnings, you can unpublish it from its edit page.

If you have questions, reply to this message.

The Civitai Team`,
  },
};
