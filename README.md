# ConsentGuard WhatsApp Campaign Sender v2.0.5

Consent-based Electron desktop application for sending controlled WhatsApp campaign messages to opted-in contacts.

## Install on Windows

Open PowerShell inside the extracted project folder:

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

- `ConsentGuard WhatsApp Campaign Sender Setup 2.0.5.exe`
- `ConsentGuard WhatsApp Campaign Sender 2.0.5.exe`

## Fix for stuck campaign with cap 3/3

If an existing campaign shows `Separate campaign cap: 3` and the log says `CAMPAIGN_LIMIT_REACHED`, press **Clear cap** on that campaign card, or press **Resume** and confirm the prompt to clear the cap. The campaign will then use only the global daily limit from Settings.

## Contacts bulk actions

The Contacts tab now includes:

- Select visible contacts
- Bulk action dropdown
- Opt out selected
- Opt out all matching search/filter
- Re-subscribe selected
- Delete selected from contact list
- Delete all matching search/filter

Opt-out adds contacts to the permanent suppression list. Delete removes them from the local contact list only.
