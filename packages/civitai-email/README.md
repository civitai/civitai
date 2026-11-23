# @civitai/email

Transactional email for Civitai apps — a nodemailer-backed `sendEmail`, plus a small `createEmail`
HTML builder. No-ops cleanly when SMTP isn't configured.

## Add to an app

```jsonc
// package.json
"@civitai/email": "workspace:*"
```

Transpile (raw TS): Next `transpilePackages: ['@civitai/email']`, Vite `ssr.noExternal: ['@civitai/email']`.

## Env

All optional — `isEmailConfigured()` is false when unset and `sendEmail` becomes a no-op.

| Var | Notes |
|---|---|
| `EMAIL_HOST` | SMTP host (e.g. `smtp.resend.com`) |
| `EMAIL_PORT` | SMTP port |
| `EMAIL_USER` / `EMAIL_PASS` | SMTP credentials |
| `EMAIL_SECURE` | `true` for TLS-on-connect |
| `EMAIL_FROM` | default From header |

## Use

```ts
import { sendEmail, isEmailConfigured, createEmail } from '@civitai/email';

if (isEmailConfigured()) {
  await sendEmail({ to, subject, html, text });
}
```

## Layout

`renderEmailShell({ header, body, btnUrl, btnLabel, afterButton, footer, preheader, baseUrl })` is the
shared transactional layout (brand band with logo, dark-mode rules, footer) every app's emails render
through. Values are inserted as HTML, so escape anything user-supplied. `baseUrl` is the origin the logo
loads from; it defaults to `https://civitai.com`, which serves it. The main app passes its own origin
via `simpleEmailWithTemplate` in `src/server/email/templates/util.ts`.

## Gotchas

- Guard sends with `isEmailConfigured()` in environments where SMTP may be unset (dev/preview) — otherwise
  a send is silently dropped.
- `createEmail` returns `{ subject, html, text }`; `removeTags` strips HTML for the text fallback.
