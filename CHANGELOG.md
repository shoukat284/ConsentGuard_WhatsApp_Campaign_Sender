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
- Bulk delete all contacts matching the current search/filter.

## Notes

- Opting out adds contacts to the permanent suppression list.
- Deleting removes contacts from the local contact list but does not delete historical campaign recipient records.
- Existing campaigns and WhatsApp sessions stored in the Windows application-data folder are preserved.
