# SMS Gateway

A TypeScript monorepo for a desktop-hosted SMS gateway and a React Native mobile
gateway. The desktop app is intended to own campaigns, the persistent queue,
and the local API. Android devices connect over the local network and send queued
messages through a user-selected SIM.

## Workspace

- `apps/desktop` - Electron desktop shell.
- `apps/mobile` - bare React Native app (Android-first; iOS project retained).
- `packages/shared-contracts` - shared API and queue types.
- `packages/validation` - runtime request and response schemas.
- `packages/message-core` - platform-independent queue rules.
- `packages/api-client` - typed client for the gateway API.
- `db` - SQLite schema and migrations as the persistence layer is implemented.

The current scaffold builds the desktop shell and shared packages. It does not
yet host a LAN API, persist jobs, import documents, or send SMS.

## Requirements

- Node.js 22.11 or newer and npm.
- For Android: Android Studio/SDK, an emulator or connected device, and Java 21.

## Getting started

```sh
npm install
npm run build
npm run desktop
```

For Android, start Metro in one terminal and run the app from another:

```sh
npm run mobile:start
npm run android
```

The Android app needs native SMS permission and SIM selection/send integration
before it can transmit messages; those are not included in this scaffold.

## Network security

Before enabling LAN access, the gateway needs an authenticated device-pairing
flow, authorization for queue operations, and protected transport. Do not expose
an unauthenticated API on all network interfaces. Queue delivery should use
acknowledgements and idempotent job identifiers so reconnects do not silently
lose or duplicate messages.
