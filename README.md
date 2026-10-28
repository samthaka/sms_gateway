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

## Install and run

```sh
npm install
npm run build
```

Start the desktop gateway:

```sh
npm run desktop
```

For Android development, keep Metro running in one terminal:

```sh
npm run mobile:start
```

Then build and launch the app on an emulator or connected device from another
terminal:

```sh
npm run android
```

The Android app includes native pinned networking, secure storage, and SMS
handling. Rebuild and reinstall it with `npm run android` after native changes;
a Metro refresh alone is not enough.

## First-time setup and sending messages

1. Start the desktop app and the Android app using the commands above. Keep the
   desktop gateway running while using the phone.
2. In the mobile app, choose **Scan desktop QR code**. Allow camera access when
   prompted and scan a QR code displayed by the desktop app.
3. In the desktop app, upload an Excel spreadsheet (.xls or .xlsx), select its
   worksheet, choose the phone-number column, and write a message using the
   spreadsheet's column placeholders.
4. Select the paired phone and choose **Queue messages on phone**.
5. On the phone, grant SMS permission if requested, then confirm the batch to
   begin sending.

The desktop and each paired phone show pending messages, failed attempts, and
sent messages. A failed message can be retried, which returns it to the pending
queue, or permanently deleted. Retrying does not send automatically: the phone
still requires the user to confirm sending the pending batch. Messages are
grouped by date, with **Today** and **Yesterday** labels for recent activity.

Messages are submitted one at a time using Android's default SIM. Keep the
mobile app open during sending. The sent list shows messages Android confirms
it submitted. When Android later receives a carrier delivery report, the apps
also show **Delivered** or **Not delivered**. Carriers and recipient networks
do not always provide delivery reports; without one, the status remains
**Sent**. Delivery reports use the existing SMS permission; Android does not
require an additional runtime permission for these callbacks. Carrier charges
may apply. Jobs left in an uncertain sending state after a restart are marked
failed and are not automatically retried, to avoid accidental duplicate
messages.

To revoke a paired device, use the desktop app. **Forget on this phone** only
removes the local credential; it does not revoke desktop access.

## Pairing and QR codes

Each QR code contains the desktop gateway's HTTPS address, its SHA-256
public-key pin, a six-digit one-time pairing code, the gateway server ID,
protocol version, and code expiry time. Before sending the code, the mobile app
validates the QR payload and expiry, connects using the provided certificate
pin, and checks that the gateway health response has the same server ID. The
pairing code is not sent if either check fails. The returned device credential
is stored in secure storage, and the desktop displays separate QR codes for
its available network addresses.

Scan the QR code directly from the intended desktop app, not from a screenshot
or a code provided by someone else. The QR scan is the out-of-band trust step:
anyone who copies a live QR code could race the intended phone to use its
one-time code, so keep the desktop screen private while pairing.

The desktop generates a pairing code when its gateway starts. It expires after
five minutes and is automatically replaced until a device pairs. A code can be
used only once. After a successful pairing, generating another QR code requires
an explicit action in the desktop app. Failed pairing attempts are limited to
five in a rolling five-minute window; rotating a code does not reset this limit.
When the limit is reached, pairing requests are rejected until attempts age out
of the window.

The camera permission is requested only when scanning starts. QR contents are
decoded on the phone; camera frames are not uploaded. The paired-device label
uses the configured Android device name when the operating system exposes it,
and otherwise falls back to the Android model name.

The scanner uses VisionCamera and requests camera access at runtime. Android
uses the native code-scanner configuration. The pinned gateway transport is
currently Android-only; QR scanning on another platform does not add pinned
pairing support there.

## Running tests

Run the complete test suite from the repository root:

```sh
npm test
```

This builds the shared packages and desktop app first, then runs the desktop,
message-core, validation, and mobile test suites.

To run only the mobile app tests:

```sh
npm test --workspace=@sms-gateway/mobile -- --runInBand
```

The desktop test suite uses the compiled output, so build the workspaces before
running it directly:

```sh
npm run build
npm test --workspace=@sms-gateway/desktop
```

## Network security

Android debug builds allow cleartext for React Native's local Metro development
server; release builds block cleartext. Gateway traffic itself uses HTTPS.

The QR-provided pin is used to establish trust before pairing; it is not
accepted from an unpinned network response. Subsequent requests use Android
OkHttp certificate pinning. No cleartext HTTP is enabled for gateway traffic.
The desktop certificate private key and device-token hashes are kept in the
desktop user's application data directory with owner-only POSIX file modes
where supported. Device tokens are kept in Android Keystore-backed encrypted
storage.

The desktop API authorizes queue inspection, job claiming, and result
acknowledgments with the paired device token. Jobs are persisted on the desktop
and use idempotent identifiers.
