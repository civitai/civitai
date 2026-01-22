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

First, make sure that you have the following installed on your machine:

- [Docker](https://www.docker.com/) (for running the database and services)
- If using devcontainers
    - An IDE that supports them (VS Code with devcontainers extension, Jetbrains, etc.)
- If running directly
    - Node.js (version 20 or later)
        - We recommend you have installed `nvm` in order to set the right node version to run this project
          ```sh
          curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
          ```
    - Make (optional, for easier initial setup)

### Installation

1. Follow the [Prerequisites](#prerequisites) steps above
2. Clone the repository to your local machine
3. Choose one method:
    - a) Use devcontainers
      > ⚠️ Important Warning for Windows Users: Either clone this repo onto a WSL volume, or use the "clone repository in named container volume"
      command. Otherwise, you will see performance issues.
        - Open the directory up in your IDE of choice
            - VS Code should prompt you to "Open in container"
                - If not, you may need to manually run `Dev Containers: Open Folder in Container`
            - For other IDEs, you may need to open the `.devcontainer/devcontainer.json` file, and click "Create devcontainer and mount sources"
            - _Note: this may take some time to run initially_
        - Run `make run` or `npm run dev`
    - b) Run `make init`
        - This command will do a few things:
            - Creates a starter `env` file
            - Installs npm packages
            - Spins up docker containers
            - Runs any additional database migrations
            - Creates some dummy seed data
            - Populates metrics and meilisearch
            - Initializes prisma
            - Runs the server
        - If you see an error about an app not being found, make sure `node_modules/.bin` is added to your path:
            - `export PATH="$PATH:$(realpath node_modules/.bin)"`
        - If you are an internal member, you can use the buzz and signals service
            - Set this up once by creating a personal access token in github (with read package permissions)
            - Set that to `CR_PAT` env
            - Run `echo $CR_PAT | docker login ghcr.io -u USERNAME --password-stdin`
    - Please report any issues with these commands to us on [discord][discord-url]
4. Edit the `.env.development` file
    - Most default values are configured to work out of the box, except the S3 upload key and secret. To generate those, navigate to
      the minio web interface at [http://localhost:9000](http://localhost:9000) with the default username and password `minioadmin`, and then navigate
      to the "Access Keys" tab. Click "Create Access Key" and copy the generated key and secret into the `.env` file (`S3_UPLOAD_KEY` and `S3_UPLOAD_SECRET`, `S3_IMAGE_UPLOAD_KEY` and `S3_IMAGE_UPLOAD_SECRET`).
    - Set `WEBHOOK_TOKEN` to a random string of your choice. This will be used to authenticate requests to the webhook endpoint.
    - Add a random string of your choice to the email properties to allow user registration
        - `EMAIL_USER`
        - `EMAIL_PASS`
        - `EMAIL_FROM` (Valid email format needed)
5. Run `git submodule update --recursive`
6. Finally, visit [http://localhost:3000](http://localhost:3000) to see the website.

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

1. Make your changes to the `schema.prisma` file
2. Create a folder in the `prisma/migrations folder` named with the convention `YYYYMMDDHHmmss_brief_description_here`
3. In this folder, create a file called `migration.sql`
4. In that file, put your sql changes
    - These are usually simple sql commands like `ALTER TABLE ...`
5. Run `make run-migrations` and `make gen-prisma`
6. If you are adding/changing a column or table, please try to keep the `gen_seed.ts` file up to date with these changes

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

 
  
