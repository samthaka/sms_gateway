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

The desktop hosts a LAN gateway on port `47832` over HTTPS. Android devices pair
with a short-lived code after manually verifying the desktop certificate
fingerprint. Paired device credentials are stored as hashes on desktop and
encrypted with Android Keystore on the phone. This milestone does not yet queue
or send SMS. The desktop app can save uploaded Excel spreadsheets (.xls and
.xlsx) in its per-user application data directory.

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

This milestone adds a native Android networking and secure-storage module, so
rebuild/reinstall Android with `npm run android`; a Metro refresh alone is not
enough.

When the desktop and mobile apps  are running:

1. Open the mobile app, grant camera permissions and scan the QR code on the desktop app.
2. Revoke paired devices from the desktop. **Forget on this phone** removes
   local credentials only; it does not revoke desktop access.
3. Upload a spreadsheet.

The Android app needs native SMS permission and SIM selection/send integration
before it can transmit messages; those are not included in this milestone.

## Network security

Android debug builds allow cleartext for React Native's local Metro development
server; release builds block cleartext. Gateway traffic itself uses HTTPS.

The Android app first inspects the server certificate without sending pairing
credentials. It only sends the one-time pairing code after the user explicitly
confirms the displayed public-key fingerprint. Subsequent requests use Android
OkHttp certificate pinning; no cleartext HTTP is enabled. The certificate
private key and device-token hashes are kept in the desktop user's application
data directory with owner-only POSIX file modes where supported. Device tokens
are kept in Android Keystore-backed encrypted storage.

The desktop API currently exposes health, pairing, paired-device identity, and
desktop-local device revocation only. Before adding queue or campaign operations,
authorize each operation and use acknowledgments and idempotent job identifiers
so reconnects do not silently lose or duplicate messages.
