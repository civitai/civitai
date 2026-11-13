# Emailed sign-in invites

A system app can have the hub email someone a link that signs them in, creating their account if the address
is new. Civitai Advertising uses it to invite people to an ad account.

## Who can send

Any confidential system app (registered on hub admin, OAuth Apps) whose access is not Disabled. This is
re-checked when a link is used, so disabling the app also stops invites already sent.

## Sending

`POST /api/auth/invite`, authenticated as the app with HTTP Basic (client ID and secret).

```json
{ "email": "bob@example.com", "returnUrl": "https://advertising.civitai.com/invite/abc", "invitedBy": "Alice", "message": "join the ad account \"Acme\"" }
```

- `email` must be a plain address.
- `returnUrl` must be absolute, on one of the app's allowed origins, and on a host the hub's post-login
  redirect follows.
- `invitedBy` and `message` are optional plain text with length caps. They are escaped in the email and
  never made into links by the hub, though mail clients may still auto-link text that looks like a domain.

| Status | Meaning |
|---|---|
| `202 { expiresAt }` | Emailed. The link is never returned to the caller. |
| `400` | Bad body, email, `returnUrl` or text length. |
| `401` | Bad client credentials. |
| `403` | The app is not an enabled confidential system app, or the address may not start a new account (the same rules as the email sign-in form; they don't apply to an existing account). |
| `429` | Per-app or per-recipient limit reached. |
| `503` | Email is not configured on this hub. |

The email is one generic template; the app's name comes from its registration, not the request.

## Accepting

The link is `/invite?token=…`. It is single use and expires after 7 days. A resend for the same app, address
and `returnUrl` replaces the earlier link.

- The GET only shows the invite, so a mail scanner fetching the link can't use it up.
- **Accept** posts back to the page. The hub re-checks the app, the origin and the new-account rules, spends
  the token, finds or creates the account by email, starts the hub session and redirects to `returnUrl`.
  No onboarding step.
- Following the link proves the visitor controls the inbox, the same trust as the magic link. An app that
  needs a specific address signed in should still compare the session's email with the one it invited.

Tokens are stored hashed in `OauthInvite`, deleted on use, and removed with their app. Audit events:
`invite.sent` and `invite.used`.
