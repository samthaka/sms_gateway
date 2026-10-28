# SMS Gateway

A TypeScript monorepo for a desktop-hosted SMS gateway and a React Native mobile
gateway. The desktop app is intended to own campaigns, the persistent queue,
and the local API. Android devices connect over the local network and send queued
messages through the default SIM.

## Workspace

- `apps/desktop` - Electron desktop shell.
- `apps/mobile` - bare React Native app (Android-first; iOS project retained).
- `packages/shared-contracts` - shared API and queue types.
- `packages/validation` - runtime request and response schemas.
- `packages/message-core` - platform-independent queue rules.
- `packages/api-client` - typed client for the gateway API.
- `db` - SQLite schema and migrations as the persistence layer is implemented.

The desktop hosts a LAN gateway on port `47832` over HTTPS. Android devices pair
with a short-lived QR code. Paired device credentials are stored as hashes on desktop and
encrypted with Android Keystore on the phone. The desktop app saves uploaded Excel spreadsheets (.xls and .xlsx) in its
per-user application data directory, selects a workbook and worksheet, and
composes a personalized message template using spreadsheet column headers. It
can queue a message for each data row to a selected paired Android phone. The
phone sends the batch while the app is open, after SMS permission and explicit
batch confirmation.

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

The native Android app includes pinned networking, secure storage, and SMS
sending, so rebuild/reinstall Android with `npm run android`; a Metro refresh
alone is not enough.

When the desktop and mobile apps are running:

1. Open the mobile app, grant camera permissions and scan the QR code on the desktop app.
2. Upload a spreadsheet, select its worksheet and phone-number column, and
   write a message using the column placeholders.
3. Select the paired phone and choose **Queue messages on phone**.
4. On the phone, grant SMS permission and confirm the batch to begin sending.
5. Revoke paired devices from the desktop when needed. **Forget on this phone**
   removes local credentials only; it does not revoke desktop access.

The desktop and each paired phone show their pending messages and failed
attempts. A failed message can be retried, which returns it to the pending
queue, or permanently deleted. Retrying does not send automatically: the phone
still requires the user to confirm sending the pending batch.

Messages are submitted one at a time using Android's default SIM. Keep the
mobile app open during sending. The sent list shows messages Android confirms
it submitted. When Android later receives a carrier delivery report, the apps
also show **Delivered** or **Not delivered**. Carriers and recipient networks
do not always provide delivery reports; without one, the status remains **Sent**.
Delivery reports use the existing SMS permission; Android does not require an
additional runtime permission for these callbacks. Carrier charges may apply.
Jobs left in an uncertain sending state after a restart are marked failed and
are not automatically retried, to avoid accidental duplicate messages.

## Network security

Android debug builds allow cleartext for React Native's local Metro development
server; release builds block cleartext. Gateway traffic itself uses HTTPS.

 Subsequent requests use Android OkHttp certificate pinning; no cleartext HTTP is enabled. The certificate
private key and device-token hashes are kept in the desktop user's application
data directory with owner-only POSIX file modes where supported. Device tokens
are kept in Android Keystore-backed encrypted storage.

The desktop API authorizes queue inspection, job claiming, and result
acknowledgments with the paired device token. Jobs are persisted on the desktop
and use idempotent identifiers.
