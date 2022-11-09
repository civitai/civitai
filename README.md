[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]

<br />
<div align="center">
  <a href="https://civitai.com/">
    <img src="media/logo.png" alt="Logo" width="120" height="40">
  </a>
</div>

## Table of Content
- [About the Project](#about-the-project)
  - [Built with](#built-with)
  - [Features](#features)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Important Scripts](#important-scripts)
- [Contributing](#contributing)
- [Sponsors](#sponsors)
- [License](#license)



## About the Project

![Civitai Homepage Screenshot](media/header.png)

Share you models, textual inversions, hypernetworks, aesthetic gradients, and any other crazy stuff people do to customize their AI generations.

### Built with
- **DB:** Prisma + Postgres
- **API:** tRPC
- **Front-end + Back-end:** NextJS
- **UI Kit:** [Mantine](https://mantine.dev/)
- **Storage:** Cloudflare
- **Hosting:** Railway

### Features
- Browse Models
  - Name, tags, downloads, favorites
- Interacting with Models
  - Name
  - Trained Words (a list of words that this model knows)
  - Description
  - Type (Model, Textual Inversion)
  - Example Images
  - Versions
    - Name
    - Changelog/Description/Notes
    - Training Images (optional)
    - Training Steps
    - Download (Tracked)
  - Tag (Completely open)
  - Reviews
    - Version
    - Images Attachments
    - Text Review
    - Rate (Star system 1-5)

## Getting Started

To get a local copy up and running follow these simple example steps.

### Prerequisites

We recommend you have installed `nvm` in order to set the right node version to run this project
```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.2/install.sh | bash
```

### Installation

1. Clone the repo
   ```sh
   git clone https://github.com/civitai/civitai.git
   ```
1. Install NPM packages
   ```sh
   npm install
   ```
1. Config your env vars
   ```sh
   cp .env-example .env
   ```

### Important Scripts
```sh
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

1. Fork the Project
1. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
1. Commit your Changes (`git commit -am 'Add some AmazingFeature'`)
1. Push to the Branch (`git push origin feature/AmazingFeature`)
1. Open a Pull Request

## Sponsors

Support this project by becoming a sponsor. Your logo will show up here with a link to your website.

## License
Apache License 2.0 - Please have a look at the [LICENSE](/LICENSE) for more details.
