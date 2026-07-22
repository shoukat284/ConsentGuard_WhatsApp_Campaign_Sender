# ConsentGuard WhatsApp Campaign Sender v2.0.7

Consent-based Electron desktop application for sending controlled WhatsApp campaign messages to opted-in contacts.

## Install on Windows

Open PowerShell inside the project folder:

```powershell
$env:PUPPETEER_SKIP_DOWNLOAD = "true"
npm install --no-audit --no-fund
npm run check
npm test
npm start
```

## Build installer and portable EXE

```powershell
npm run dist:win
```

Send the two generated EXE files from `dist`:

- `ConsentGuard WhatsApp Campaign Sender Setup 2.0.7.exe`
- `ConsentGuard WhatsApp Campaign Sender 2.0.7.exe`

## Contacts bulk-action dropdown fix

Version 2.0.7 fixes a Contacts tab issue where the **Bulk action** dropdown could become stuck or difficult to open after deleting selected contacts.

The Contacts bulk-action flow now:

- Uses a dedicated stability guard for the Contacts toolbar.
- Prevents the old click handler from running twice.
- Disables the dropdown and Apply button only while the action is processing.
- Always re-enables the dropdown and Apply button after success, failure, or cancellation.
- Clears selected contact state after successful opt-out, re-subscribe, or delete actions.
- Resets the dropdown again after the contacts table refreshes, avoiding a stale Chromium native-select focus state.

## WhatsApp Connect lock recovery

Version 2.0.6 fixes this error:

```text
The browser is already running for C:\Users\gh\AppData\Roaming\consentguard-whatsapp-campaign-sender\whatsapp-auth\session-marketing-desktop. Use a different userDataDir or stop the running browser first.
```

The app now prevents duplicate Connect clicks from starting a second Chromium instance on the same WhatsApp profile. If an old hidden Chrome/Edge process or stale Chromium lock file remains after a crash, the app automatically cleans only the browser process tied to this app's WhatsApp session path and then retries the connection once.

If Windows still keeps the browser locked, close the app completely, open Task Manager, end any stuck Chrome/Edge process created by this app, and reopen the app. You should not need to delete the WhatsApp session or rescan unless the session itself is invalid.

## Fix for stuck campaign with cap 3/3

If an existing campaign shows `Separate campaign cap: 3` and the log says `CAMPAIGN_LIMIT_REACHED`, press **Clear cap** on that campaign card, or press **Resume** and confirm the prompt to clear the cap. The campaign will then use only the global daily limit from Settings.

## Contacts bulk actions

The Contacts tab includes:

- Select visible contacts
- Bulk action dropdown
- Opt out selected
- Opt out all matching search/filter
- Re-subscribe selected
- Delete selected from contact list
- Delete all matching search/filter

Opt-out adds contacts to the permanent suppression list. Delete removes them from the local contact list only.
