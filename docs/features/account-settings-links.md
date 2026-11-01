# Account settings deep links

Link straight to a setting on `/user/account`. Source: `src/components/Account/setting-links.ts`
(the format and the anchor table), `useSettingDeepLink.ts` (scroll and highlight).

## Format

| Link | Lands on |
|------|----------|
| `/user/account/<pane>` | a pane: `profile`, `preferences`, `notifications`, `content`, `creator`, `billing`, `security` |
| `/user/account?setting=<anchor>` | the pane that owns `<anchor>`, scrolled to it and briefly highlighted |
| `/user/account/<pane>?setting=<anchor>` | the same, naming the pane yourself |

`#<anchor>` works in place of `?setting=<anchor>`. **Hand out the `?setting=` form:** a fragment never
reaches the server, so a signed-out visitor comes back from login without it. The page sends them to
`/login?returnUrl=<the full URL>`, which keeps the query.

`/user/account/<pane>` only exists while the `accountSettingsV2` shell is on. With it off, the single
legacy page renders, and `?setting=<anchor>` scrolls to a matching element only where that page has one.

## Anchors

An anchor is the element `id`. A section's id is the slug of its title unless the component sets one.

| Pane | Anchors |
|------|---------|
| profile | `account-info`, `creator-profile`, `account-standing`, `refresh-session`, `delete-account` |
| preferences | `media-playback`, `generation`, `file-preferences`, `civbot-assistant`, `privacy`, `hide-reaction-lists`, `features` |
| notifications | `delivery` |
| content | `ads`, `mature-content`, `topics`, `hidden-tags`, `hidden-users` |
| creator | `metric-visibility`, `stickers` |
| billing | `manage-subscription`, `payment-methods`, `payments`, `membership-gifts` |
| security | `accounts`, `api-keys`, `oauth-applications`, `connected-apps`, `store-items` |

`hide-reaction-lists` is the "Hide me from 'who reacted' and 'who collected' lists" switch:
`/user/account?setting=hide-reaction-lists`.

Some anchors only exist for members or behind a flag (`ads`, `metric-visibility`, `mature-content`,
`api-keys`, ...). A link to one the viewer does not have lands on the pane and scrolls nowhere.

## Adding a setting

Give the section or control an `id`, then add it to `settingPanes`. A `SettingsSection` or
`CardOrSection` with a string `title` gets one for free. For a bare control such as a `Switch`, wrap
it in an element carrying the id: Mantine puts a Switch's own `id` on the hidden input, which is not
the scroll target.

`setting-links.test.ts` fails if an entry matches no id or title in `src/components/Account/`.

Ids that older links already use (`strikes`, `payments`, `accounts`, ...) are in
`legacyAnchorSections` in `account-sections.ts`. Do not rename them.
