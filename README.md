# Layer Bot

Standalone Discord bot for Layer. This repository contains only the bot: Discord commands, events, moderation, tickets, verification, giveaways, the bot HTTP API, Prisma schema, and runtime assets.

## Requirements

- Node.js 20 or newer
- PostgreSQL database
- Native build tools for `canvas` (the package may download a prebuilt binary)
- Discord bot token and the Discord application/client ID

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`, then prepare the database:

```bash
npx prisma generate
npx prisma db push
```

Use `prisma db push` for a fresh database. If the target database already matches the schema, `npx prisma generate` is enough.

Build and start:

```bash
npm run build
npm start
```

For local development:

```bash
npm run dev
```

`npm install` and `npm run build` both run `prisma generate`; the build also copies `assets/` into `dist/assets/`.

## Environment

See [`.env.example`](.env.example) for the complete list. The main values are:

- `DISCORD_TOKEN`, `CLIENT_ID`, optional `DEV_GUILD_ID`
- `DATABASE_URL`
- `GEMINI_API_KEY`, `HUGGINGFACE_API_KEY`
- `BOT_API_SECRET`, `MONITOR_API_SECRET`
- `WEB_APP_URL`, `NEXTAUTH_URL`
- optional `STATUS_HEARTBEAT_URL` and `STATUS_HEARTBEAT_TOKEN`
- `FINGERPRINT_ENCRYPTION_KEY` in production

Never commit `.env`. The HTTP API listens on `PORT` or `BOT_API_PORT` (default `3001`) and requires bearer authentication for its routes.

## Runtime assets

- `assets/fonts/` is used for generated rank, ticket, and verification images.
- `assets/ticket-banner.png` is attached to ticket panels.
- `assets/voice-waiting-room/` contains waiting-room audio.
- `eng.traineddata` is the English Tesseract language/model file.

## Deployment

The bot is a long-running Node.js process and needs a PostgreSQL database. It can run on any Node-compatible host or container platform; it is not a serverless function.
