# RGB Proxy

Set up and manage RGB mode for local development — test green, blue, and red domains simultaneously.

Use when the user asks to "set up RGB mode", "enable RGB proxy", "test green/blue/red domains", or "run RGB mode".

## What It Does

RGB mode lets you test all three Civitai domain colors (green, blue, red) locally by running a reverse proxy that maps:
- `https://civitai-dev.green` → `http://localhost:3000`
- `https://civitai-dev.blue` → `http://localhost:3000`
- `https://civitai-dev.red` → `http://localhost:3000`

The Next.js app reads the `Host` header to determine which domain color is active, enabling domain-specific feature flags and theming.

## Setup Steps

Run these steps in order. The skill handles everything except the hosts file (which requires user action).

### 1. Clone the proxy repo (if not already present)

Check if the repo exists at a reasonable location. Common spots:
- `../rgb-proxy` (sibling to model-share)
- `../../civitai/rgb-proxy`

If not found, clone it:
```bash
git clone https://github.com/civitai/rgb-proxy.git <chosen-path>
```

### 2. Install dependencies

```bash
cd <proxy-path> && npm install
```

### 3. Guide the user to update their hosts file

Detect the OS and provide the right instructions:

**Windows:**
```
Edit C:\Windows\System32\drivers\etc\hosts (run editor as Administrator)
Add these lines:

127.0.0.1 civitai-dev.green
127.0.0.1 civitai-dev.red
127.0.0.1 civitai-dev.blue
```

**macOS/Linux:**
```
sudo nano /etc/hosts
Add these lines:

127.0.0.1 civitai-dev.green
127.0.0.1 civitai-dev.red
127.0.0.1 civitai-dev.blue
```

Ask the user to confirm they've done this before proceeding.

### 4. Update .env for RGB mode

In the model-share `.env` file, ensure these values are set (comment out the non-RGB defaults):

```env
# Non-RGB defaults (comment these out)
# NEXTAUTH_URL=http://localhost:3000
# SERVER_DOMAIN_BLUE=localhost:3000

# RGB Mode
AUTH_TRUST_HOST=true
NEXTAUTH_URL=https://civitai-dev.blue
NEXTAUTH_URL_INTERNAL=http://localhost:3000
SERVER_DOMAIN_GREEN=civitai-dev.green
SERVER_DOMAIN_BLUE=civitai-dev.blue
SERVER_DOMAIN_RED=civitai-dev.red

# Optional alias hosts (comma-separated). Resolve to the same color on inbound
# requests but never appear in outbound URLs. Use to test multi-host-per-color
# behavior locally.
# SERVER_DOMAIN_BLUE_ALIASES=civitai-dev.cyan
```

### Testing alias hosts

To exercise the alias-host code path locally:

1. Add a fourth hostname to your hosts file (e.g. `127.0.0.1 civitai-dev.cyan`).
2. Set `SERVER_DOMAIN_BLUE_ALIASES=civitai-dev.cyan` in `.env`.
3. Add a matching `proxy.register('civitai-dev.cyan', 'http://localhost:3000', { ssl: { ... } })` entry to `rgb-proxy/index.mjs` (and generate certs if needed).
4. Restart the proxy and dev server.
5. `https://civitai-dev.cyan` resolves to color `blue` but uses its own host header — verify the login page hides any provider that lacks an alias-keyed credential, and shows a "Continue on civitai-dev.blue" fallback button.

To test alias-keyed OAuth credentials: set `DISCORD_AUTH_civitai_dev_cyan=clientid,secret` (slug is the host with non-alphanumeric characters replaced by `_`). Providers without an `<UPPER>_AUTH_<slug>` env var are hidden on the alias.

### 5. Start the proxy

```bash
cd <proxy-path> && npm start
```

Run this with `run_in_background=true` so it stays running.

The proxy requires ports 80 and 443. On Windows, run the terminal as Administrator. On macOS/Linux, use `sudo npm start`.

### 6. Restart the dev server

The env var changes require a dev server restart. Use the `/dev-server` skill to restart it.

### 7. Visit the domains

- `https://civitai-dev.green` — SFW / safe site (green domain)
- `https://civitai-dev.blue` — Default / main site (blue domain)
- `https://civitai-dev.red` — NSFW / mature content (red domain)

The browser will warn about self-signed certificates — accept/bypass the warning.

## Disabling RGB Mode

To go back to normal single-domain development:

1. Stop the proxy process
2. In `.env`, swap back to non-RGB defaults:
```env
NEXTAUTH_URL=http://localhost:3000
SERVER_DOMAIN_BLUE=localhost:3000
# Comment out or remove the RGB-specific lines
```
3. Restart the dev server

## Notes

- With shared dev OAuth secrets, only **Discord and Google** login work on these domains
- The proxy uses self-signed SSL certificates — browsers will show security warnings
- You can use the testing-login endpoint (`/api/auth/signin/testing-login`) in dev mode to bypass OAuth
- To sync accounts between domains, visit a domain with `?sync-account=blue` (or green/red)
