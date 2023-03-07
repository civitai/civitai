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

## Table of Content
- [About the Project](#about-the-project)
  - [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Important Scripts](#important-scripts)
- [Contributing](#contributing)
- [Sponsors](#sponsors)
- [License](#license)

## About the Project

Our goal with this project is to create a platform where people can share their stable diffusion models (textual inversions, hypernetworks, aesthetic gradients, VAEs, and any other crazy stuff people do to customize their AI generations), collaborate with others to improve them, and learn from each other's work. The platform allows users to create an account, upload their models, and browse models that have been shared by others. Users can also leave comments and feedback on each other's models to facilitate collaboration and knowledge sharing.

### Tech Stack

We've built this project using a combination of modern web technologies, including Next.js for the frontend, TRPC for the API, and Prisma + Postgres for the database. By leveraging these tools, we've been able to create a scalable and maintainable platform that is both user-friendly and powerful.

- **DB:** Prisma + Postgres
- **API:** tRPC
- **Front-end + Back-end:** NextJS
- **UI Kit:** [Mantine](https://mantine.dev/)
- **Storage:** Cloudflare

## Getting Started

To get a local copy up and running follow these simple example steps.

### Prerequisites

First, make sure that you have the following installed on your machine:
- Node.js (version 18 or later)
- Docker (for running the database)

> We recommend you have installed `nvm` in order to set the right node version to run this project
> ```sh
> curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.2/install.sh | bash
> ```

### Installation

1. Clone the repository to your local machine.
1. Run `npm install` in the project directory to install the necessary dependencies.
1. Spin up required services with `docker-compose up -d`
    * Note: In addition to postgres and redis, this will also run maildev for email and minio for s3 storage with all necessary buckets automatically created, minio and maildev are not strictly needed but are preferred for testing and development purposes.
1. Create your `.env` by making a copy of the contents from `.env-example` file.
    * Most default values are configured to work with the docker-compose setup, with the exception of the S3 upload key and secret. To generate those, navigate to the minio web interface at [http://localhost:9000](http://localhost:9000) with the default username and password `minioadmin`, and then navigate to the "Access Keys" tab. Click "Create Access Key" and copy the generated key and secret into the `.env` file.
    * Set `WEBHOOK_TOKEN` to a random string of your choice. This will be used to authenticate requests to the webhook endpoint.
1. Run `npm run db:migrate` to run all database migrations.
1. Run `npm run db:generate` to generate the prisma client.
1. Start the development server by running `npm run dev`.
1. Visit the page `http://localhost:3000/api/webhooks/run-jobs?token=WEBHOOK_TOKEN&run=update-metrics` to start the metrics update job (make sure to substitute `WEBHOOK_TOKEN`)
1. Finally, visit [http://localhost:3000](http://localhost:3000) to see the website.
    * Note that account creation will run emails through maildev, which can be accessed at [http://localhost:1080](http://localhost:1080).
    * Also note that Cloudflare credentials are necessary in order for image uploads to work.

### Important Scripts
```sh
docker-compose up -d # Spin up db, redis, maildev, and minio

npm run dev # Start the dev environment

npm run db:migrate -- --name migration-name # Create a database migration with prisma after updating the schema

npm run db:generate # Generates local prisma client

npm run db:ui # Start Prisma Studio to manage the database content

npm run build # Build the NextJS project
```

## Contributing

Any contributions you make are **greatly appreciated**.

If you have a suggestion that would make this better, please fork the repo and create a pull request. You can also simply open an issue with the tag "enhancement".
Don't forget to give the project a star! Thanks again!

1. Fork the repository to your own GitHub account.
1. Create a new branch for your changes.
1. Make your changes to the code.
1. Commit your changes and push the branch to your forked repository.
1. Open a pull request on our repository.

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
