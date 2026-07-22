# Verification Report — v2.0.5

## Scope

This build addresses the campaign cap stall shown by the log:

`CAMPAIGN_LIMIT_REACHED: Separate campaign cap reached (3/3)`

It also adds centralized contact bulk actions requested for the Contacts tab.

## Verified in this environment

- JavaScript syntax check passed for 13 JavaScript files.
- Source package excludes `node_modules`.
- Source package excludes `.wwebjs_auth`, `whatsapp-auth`, databases, and build output.
- Version number updated to 2.0.5.
- Added automated regression tests for:
  - Bulk opt-out selected contacts.
  - Bulk delete all matching contacts.
  - Reached separate campaign cap refusing resume before worker activation.

## Runtime tests to perform on Windows

After extracting the ZIP:

```powershell
$env:PUPPETEER_SKIP_DOWNLOAD = "true"
npm install --no-audit --no-fund
npm run check
npm test
npm start
```

Expected test result after dependencies install:

```text
tests 12
pass 12
fail 0
```

A live WhatsApp account was not connected inside this environment, so QR scanning and real message delivery must still be verified with opted-in internal test numbers on Windows.
