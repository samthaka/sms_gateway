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

The desktop starts a LAN health endpoint on port `47832`. The Android app can
check that endpoint using a manually entered desktop address. This first
connection milestone does not yet pair devices, persist jobs, import documents,
or send SMS.

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

When the desktop is running, it displays LAN addresses on port `47832`. Enter
one in the Android app and tap **Connect**. For the Android emulator running on
the same computer, keep the default `http://10.0.2.2:47832`. A physical phone
must be on the same local network; allow the app through the desktop firewall
for private networks if prompted.

This connection check only verifies the desktop gateway is reachable. It does
not yet pair or register the device, deliver jobs, or send SMS.

The Android app needs native SMS permission and SIM selection/send integration
before it can transmit messages; those are not included in this milestone.
For local HTTP testing, cleartext network traffic is enabled in Android debug
builds only. Release builds continue to block cleartext.

## Network security

The current LAN endpoint exposes health status only. Before adding queue or
campaign operations, implement authenticated device pairing, authorization for
each operation, and protected transport. Do not expose an unauthenticated
message API on all network interfaces. Queue delivery should use acknowledgments
and idempotent job identifiers so reconnects do not silently lose or duplicate
messages.
