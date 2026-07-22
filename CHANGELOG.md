# ConsentGuard WhatsApp Campaign Sender v2.0.7

## Fixed

- Fixed the Contacts tab bulk-action dropdown freezing or becoming difficult to select after deleting selected contacts.
- Added a dedicated renderer-side stability guard for Contacts bulk actions.
- Bulk actions now disable controls only while the operation is running and always re-enable the dropdown and Apply button in a `finally` cleanup path.
- After opt-out, re-subscribe, or delete bulk actions, selected contact state, the visible checkbox state, and the dropdown value are reset safely.
- Added an extra post-render reset after the contacts table refreshes to avoid Chromium keeping the native select control in a stale focused state.

## Notes

- This fix does not change contact deletion rules. Delete still removes contacts only from the local contact list and does not remove historical campaign recipient records.
- Opt-out still adds contacts to the permanent suppression list.

---

# ConsentGuard WhatsApp Campaign Sender v2.0.6

## Fixed

- Fixed WhatsApp Connect failure when Chromium reports: `The browser is already running ... Use a different userDataDir or stop the running browser first`.
- Added a single in-flight WhatsApp startup guard so repeated clicks on **Connect WhatsApp** reuse the same startup instead of launching another browser against the same session folder.
- Added automatic recovery for stale WhatsApp browser profile locks in the app-data session directory.
- Added targeted stale-browser cleanup that only stops Chrome/Edge/Chromium processes whose command line contains this app's WhatsApp session path.
- Added safe removal of orphan Chromium lock files such as `SingletonLock`, `SingletonSocket`, and `SingletonCookie` after a crash or forced close.
- Ignored delayed events from old WhatsApp clients after reconnect/recovery so stale browser events cannot overwrite the current connection state.
- Added timeout-protected browser cleanup during disconnect and logout.

## Tests

- Added WhatsApp connection tests for duplicate Connect clicks and locked-profile retry recovery.

---

# ConsentGuard WhatsApp Campaign Sender v2.0.5

## Fixed

- Prevented an already reached separate campaign cap from activating the campaign worker and immediately pausing again.
- Added a clear explanation when an existing campaign has a separate cap such as 3/3 and cannot resume until the cap is cleared or raised.
- Added a dedicated **Clear cap** button on campaign cards when a separate cap exists.
- Added resume-time prompt to clear the separate cap automatically when the cap is already reached.

## Added

- Centralized Contacts bulk-action toolbar.
- Select visible contacts checkbox.
- Per-contact row checkboxes.
- Contact status filter: all, opted in, opted out.
- Bulk opt-out selected contacts.
- Bulk opt-out all contacts matching the current search/filter.
- Bulk re-subscribe selected contacts.
- Bulk delete selected contacts from the local contact list.
- Bulk delete all contacts matching current search/filter.

## Notes

- Opting out adds contacts to the permanent suppression list.
- Deleting removes contacts from the local contact list but does not delete historical campaign recipient records.
- Existing campaigns and WhatsApp sessions stored in the Windows application-data folder are preserved.
