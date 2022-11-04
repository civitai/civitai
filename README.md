# Civitai

Share you models, textual inversions, hypernetworks, aesthetic gradients, and any other crazy stuff people do to customize their AI generations.

## Built with
- **DB:** Prisma + Postgres
- **API:** tRPC
- **Front-end + Back-end:** NextJS
- **UI Kit:** [Mantine](https://mantine.dev/)
- **Storage:** Wasabi
- **Hosting:** Railway


## Features
- [ ] Browse Models
  - [ ] Also through API for SD forks
  - [ ] Name, tags, downloads, favorites
- [ ] User accounts
  - [ ] oAuth: GitHub, Google, Discord
- [ ] Interacting with Models:
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
  - Tag (Completely open, let them tag however)
  - [ ] Reviews
    - Version? (optionally attached to a specific version)
    - Images Attachments
    - Text Review
    - Rate (Star system 1-5)

## Contributing

### Getting Started
```bash
npm i # Install all the packages
cp .env-sample .env # Create and populate the .env file
npm run dev # Start building...
```

### Important Scripts
```bash
npm run dev # Start the dev environment
npm run db:migrate -- --name migration-name # Create a database migration with prisma after updating the schema
npm run db:ui # Start Prisma Studio to manage the database content
npm run build # Build the NextJS project
```