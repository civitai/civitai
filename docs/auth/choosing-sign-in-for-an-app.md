# Choosing How an App Signs Users In

**Status:** proposed rule, for discussion. **Date:** 2026-10-26.

Every app that signs users in with a Civitai account goes through the auth hub (`auth.civitai.com`). There are
three ways to do it, and which one an app uses depends on who runs it and where it lives.

## The rule

| App                                                                                                 | How it signs in                                                                        | Managed on                                                           |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Ours, on a Civitai domain** (civitai.com, civitai.red, advertising, moderator, creator studio)    | **First-party sign-in.** The hub treats the app as one of its own sites.               | The hub admin's **Spoke Domains** page                               |
| **Ours, not on a Civitai domain** (the CLI, Civitai Link desktop, a server-side integration we run) | **A system OAuth app:** a registered OAuth client owned by the civitai system account. | The hub admin's **OAuth Apps** page                                  |
| **Someone else's**                                                                                  | **A developer OAuth app,** registered by its developer.                                | The developer's own **Account settings → OAuth Apps** on civitai.com |

### First-party sign-in

For any app we run on a Civitai domain.

- Users sign in and out with the rest of Civitai, and never see a consent screen.
- There is no client ID or secret to manage. Adding the app's host to Spoke Domains is the whole setup.
- How to build it: [spoke-integration-guide.md](./spoke-integration-guide.md).

### System OAuth apps

For apps we run that cannot use first-party sign-in, usually because they are not on a Civitai domain.

- **Owned by the civitai system account** (User id `-1`), which nobody signs in as. Staff register them on the
  OAuth Apps page, or move an existing app there with **Move to system**. Their settings are managed only on
  the hub, never by an app owner or through the API. Moving a confidential app gives it a new secret (shown
  once) so its old one stops working, and drops the `client_credentials` grant, through which the app would
  act as the system account.
- **Skip consent** (off by default): signed-in users go straight through, with no consent screen. Only for a
  **confidential** app, one with a client secret. A public app always shows consent: with no secret, any
  program could start its sign-in, and the consent screen is what stops it getting a user's token silently.
- **Token limit** (blank by default): the app's own limit per minute on the token endpoint, used once it is
  past the per-IP limit. Only for a confidential app: the limit applies after the app proves its secret. A
  public app's token calls come from each user's own address, so the per-IP limit already falls on each user.
- Redirect URIs still have to match exactly what is registered, whatever the settings.

### Developer OAuth apps

For everything else. The developer registers and manages the app; users always see the consent screen; the
standard per-IP limits apply. See [oauth-developer-docs.md](./oauth-developer-docs.md).

## Deciding

1. Is it ours and on a Civitai domain? Use **first-party sign-in**.
2. Is it ours but elsewhere (a desktop app, a CLI, a server on another domain)? Make it a **system OAuth app**.
   Turn on Skip consent or a token limit only when it is confidential and needs them.
3. Otherwise it is a **developer OAuth app**.
