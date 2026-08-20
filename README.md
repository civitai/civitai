[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![Apache License 2.0][license-shield]][license-url]
[![Discord][discord-shield]][discord-url]

<br />
<div align="center">
  <a href="https://civitai.com/">
    <img src="media/logo.png" alt="Civitai Logo" width="120" height="auto">
  </a>
</div>

## Table of Contents

- [Table of Contents](#table-of-contents)
- [About the Project](#about-the-project)
  - [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Altering your user](#altering-your-user)
  - [Known limitations](#known-limitations)
- [Contributing](#contributing)
  - [Data Migrations](#data-migrations)
- [Sponsors](#sponsors)
- [License](#license)

## About the Project

Our goal with this project is to create a platform where people can share their stable diffusion models (textual inversions, hypernetworks, aesthetic
gradients, VAEs, and any other crazy stuff people do to customize their AI generations), collaborate with others to improve them, and learn from each
other's work. The platform allows users to create an account, upload their models, and browse models that have been shared by others. Users can also
leave comments and feedback on each other's models to facilitate collaboration and knowledge sharing.

### Tech Stack

We've built this project using a combination of modern web technologies, including Next.js for the frontend, TRPC for the API, and Prisma + Postgres
for the database. By leveraging these tools, we've been able to create a scalable and maintainable platform that is both user-friendly and powerful.

- **DB:** Prisma + Postgres
- **API:** tRPC
- **Front-end + Back-end:** NextJS
- **UI Kit:** [Mantine](https://mantine.dev/)
- **Storage:** Cloudflare

## Getting Started

<details open>
<summary>To get a local copy up and running, follow these steps.</summary>

### Prerequisites

- [Docker](https://www.docker.com/), with Compose v2 (`docker compose`, not the
  retired hyphenated `docker-compose`). The database, Redis, MinIO, Meilisearch,
  ClickHouse and the mail catcher all run as containers.
- **Node.js `24.19.0`.** Not "20 or later" — `package.json` declares
  `engines.node: ">=24.0.0 <25"`. The exact version lives in [`.nvmrc`](.nvmrc);
  CI installs that file's version and the production image is built on the same
  one, so `nvm use` (or any tool that reads `.nvmrc`) is the right way to get it.
  Note that nothing stops you: `pnpm install` only prints
  `WARN Unsupported engine` and carries on, so the wrong major surfaces later as
  odd test failures rather than as a refusal at install time.
- **pnpm.** This repo is pnpm-only, and this one *is* enforced — `npm install`
  exits 1 via the `preinstall` `only-allow pnpm` hook. `corepack enable` will
  pick up the `packageManager` field for you.
- Make (optional).

### Installation

#### Standard setup

```sh
git clone https://github.com/civitai/civitai.git
cd civitai
nvm use                                              # reads .nvmrc -> 24.19.0
corepack enable
git submodule update --init event-engine-common
cp .env-example .env.development
docker compose -f docker-compose.base.yml up -d
pnpm install
pnpm dev
```

#### Optional: Nix flake

> **Optional, and not the supported default.** The standard setup above is what the
> project expects and what CI builds; nothing in the repo requires Nix, and you can
> ignore this section entirely. It exists because NixOS cannot use Prisma's published
> engines (there is no `linux-nixos` build), so a flake is the practical way to work on
> this repo there. If you are not on NixOS and not already a flakes user, skip it.

The flake owns the toolchain, so you do not install Node or pnpm yourself:

```sh
git clone https://github.com/civitai/civitai.git
cd civitai
nix run .#dev
```

That single command checks Docker is usable, checks out the
`event-engine-common` submodule, creates `.env.development` from `.env-example`
if you do not already have one, starts the container stack, waits for Postgres,
runs `pnpm install`, and then starts the dev server on
[http://localhost:3000](http://localhost:3000). Every step is idempotent — it is
safe to re-run in a checkout that already works, and it will not overwrite your
`.env.development` or touch your data.

Useful variants:

```sh
nix run .#dev -- --no-start   # bootstrap only, leave the services running
nix run .#dev -- --full       # also start the signals/buzz containers (see below)
nix run .#doctor              # check the flake's pins against the repo
nix flake check               # the same checks, plus their own self-test
```

For an interactive shell with the same toolchain, use `nix develop`, or copy
[`.envrc.example`](.envrc.example) to `.envrc` and run `direnv allow` to get it
automatically on `cd`.

#### With devcontainers

> ⚠️ **Known out of step:** `.devcontainer/public/docker-compose.yml` pins
> `mcr.microsoft.com/devcontainers/typescript-node:1-22`, i.e. Node 22, which is
> outside this repo's `engines.node` range. `pnpm install` will warn rather than
> stop, so the container comes up and then misbehaves in ways that look like your
> branch. There is no `1-24` tag (the template major moved on); `3-24` is the
> closest equivalent. Not changed here because it could not be exercised.

> ⚠️ Important Warning for Windows Users: Either clone this repo onto a WSL volume, or use the "clone repository in named container volume"
command. Otherwise, you will see performance issues.

- Open the directory up in your IDE of choice
    - VS Code should prompt you to "Open in container"
        - If not, you may need to manually run `Dev Containers: Open Folder in Container`
    - For other IDEs, you may need to open the `.devcontainer/devcontainer.json` file, and click "Create devcontainer and mount sources"
    - _Note: this may take some time to run initially_
- Run `make run`

#### The signals and buzz services

`docker-compose.base.yml` holds everything a contributor needs (and is also what
`nix run .#dev` starts). The extra services in `docker-compose.yml`
(signals, buzz) come from private `ghcr.io` images, so they only work for
internal members:

- create a GitHub personal access token with `read:packages`
- set it as `CR_PAT`
- `echo $CR_PAT | docker login ghcr.io -u USERNAME --password-stdin`
- then `docker compose up -d` (or, with the flake, `nix run .#dev -- --full`)

### After the first start

1. Edit `.env.development`. Most defaults work out of the box; these do not:
    - **S3 upload credentials.** Open the MinIO console at
      [http://localhost:9001](http://localhost:9001) (username and password both
      `minioadmin`) — note it is port **9001**, port 9000 is the S3 API itself —
      go to "Access Keys", click "Create Access Key", and copy the key and secret
      into `S3_UPLOAD_KEY` / `S3_UPLOAD_SECRET` and `S3_IMAGE_UPLOAD_KEY` /
      `S3_IMAGE_UPLOAD_SECRET`.
    - `WEBHOOK_TOKEN` — any random string; it authenticates requests to the
      webhook endpoint.
    - `EMAIL_USER`, `EMAIL_PASS`, and `EMAIL_FROM` (a valid email format) — any
      values, but they must be set for user registration to work.
2. On an empty database, populate it. These are slow and destructive, which is
   why no bootstrap runs them for you:
    ```sh
    make run-migrations
    make reseed
    ```
3. Visit [http://localhost:3000](http://localhost:3000).

Please report any issues with these commands to us on [discord][discord-url].

_&ast; Note that account creation will run emails through maildev, which can be accessed at [http://localhost:1080](http://localhost:1080)._

### Altering your user

- First, create an account for yourself as you normally would through the UI.
- You may wish to set yourself up as a moderator. To do so:
    - Use a database editor (like [DataGrip](https://www.jetbrains.com/datagrip/)) or connect directly to the
      DB (`PGPASSWORD=postgres psql -h localhost -p 15432 -U postgres civitai`)
    - Find your user (by email or username), and change `isModerator` to `true`

### Known limitations

Services that require external input will currently not work locally. These include:

- Orchestration (Generation, Training)
- Signals (Chat, Notifications, other real-time updates)
- Buzz

</details>

## Contributing

Any contributions you make are **greatly appreciated**.

If you have a suggestion that would make this better, please fork the repo and create a pull request. You can also simply open an issue with the tag "enhancement".
Don't forget to give the project a star! Thanks again!

1. Fork the repository to your own GitHub account.
2. Create a new branch for your changes.
3. Make your changes to the code.
4. Commit your changes and push the branch to your forked repository.
5. Open a pull request on our repository.

If you would like to be more involved, consider joining the **Community Development Team**! For more information on the team as well as how to join,
see [Calling All Developers: Join Civitai's Community Development Team](https://civitai.com/articles/7782).

### Data Migrations

Over the course of development, you may need to change the structure of the database. To do this:

1. Make your changes to the `packages/civitai-db-schema/prisma/schema.full.prisma` file.
   **Not `schema.prisma`** — that one is gitignored and regenerated from
   `schema.full.prisma` by `scripts/generate-slim-schema.js` on every
   `pnpm run db:generate`, so edits to it are silently overwritten.
2. Run `pnpm run db:migrate:empty "brief description here"`. This creates
   `packages/civitai-db-schema/prisma/migrations/YYYYMMDDHHmmss_brief_description_here/migration.sql`
   for you, in the one directory Prisma reads.
   To create it by hand instead, use that same path — **not** the `prisma/migrations`
   directory at the repo root, which predates the monorepo layout and is no longer read.
3. Put your sql changes in the generated `migration.sql`
    - These are usually simple sql commands like `ALTER TABLE ...`
4. Run `make run-migrations` and `make gen-prisma`
5. If you are adding/changing a column or table, please try to keep the `gen_seed.ts` file up to date with these changes.

## Sponsors

Support this project by becoming a sponsor. Your logo will show up here with a link to your website.

## License

Apache License 2.0 - Please have a look at the [LICENSE](/LICENSE) for more details.


[contributors-shield]: https://img.shields.io/github/contributors/civitai/civitai.svg?style=for-the-badge

[contributors-url]: https://github.com/civitai/civitai/graphs/contributors

[forks-shield]: https://img.shields.io/github/forks/civitai/civitai.svg?style=for-the-badge

[forks-url]: https://github.com/civitai/civitai/network/members

[stars-shield]: https://img.shields.io/github/stars/civitai/civitai.svg?style=for-the-badge

[stars-url]: https://github.com/civitai/civitai/stargazers

[issues-shield]: https://img.shields.io/github/issues/civitai/civitai.svg?style=for-the-badge

[issues-url]: https://github.com/civitai/civitai/issues

[license-shield]: https://img.shields.io/github/license/civitai/civitai.svg?style=for-the-badge

[license-url]: https://github.com/civitai/civitai/blob/master/LICENSE

[discord-shield]: https://img.shields.io/discord/1037799583784370196?style=for-the-badge

[discord-url]: https://discord.gg/UwX5wKwm6c
