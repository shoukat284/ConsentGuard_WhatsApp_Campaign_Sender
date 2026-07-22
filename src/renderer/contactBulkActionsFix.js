(() => {
  const get = (selector) => document.querySelector(selector);
  const getAll = (selector) => [...document.querySelectorAll(selector)];

  function notify(message, type = 'success') {
    if (typeof toast === 'function') toast(message, type);
    else console[type === 'error' ? 'error' : 'log'](message);
  }

  function resetBulkControls({ clearSelection = false } = {}) {
    const dropdown = get('#contact-bulk-action');
    const applyButton = get('#apply-contact-bulk');
    const selectVisible = get('#select-visible-contacts');

    if (clearSelection) {
      try { selectedContactPhones.clear(); } catch (_) { /* global lexical may not exist during isolated tests */ }
      getAll('.contact-row-check').forEach((checkbox) => { checkbox.checked = false; });
    }

    if (selectVisible) selectVisible.checked = false;
    if (dropdown) {
      dropdown.disabled = false;
      dropdown.value = '';
      dropdown.selectedIndex = 0;
      dropdown.blur();
    }
    if (applyButton) applyButton.disabled = false;

    try { updateSelectedContactCount(); } catch (_) { /* app.js not fully loaded in tests */ }
  }

  async function refreshContactsAfterBulk() {
    resetBulkControls({ clearSelection: true });
    try {
      if (typeof loadContacts === 'function') await loadContacts();
    } finally {
      // Chromium can keep a native select in a stale focused state after rows are removed.
      // Reset once more after the contact table has been repainted.
      setTimeout(() => resetBulkControls({ clearSelection: true }), 0);
    }
  }

  function selectedPhonesFromUi() {
    return getAll('.contact-row-check:checked').map((checkbox) => checkbox.value).filter(Boolean);
  }

  function buildBulkOptions(action) {
    const isAll = action.endsWith('-all');
    if (isAll) {
      return {
        isAll,
        options: {
          scope: 'allMatching',
          search: get('#contact-search')?.value || '',
          status: get('#contact-status-filter')?.value || ''
        }
      };
    }

    let phones = [];
    try { phones = [...selectedContactPhones]; } catch (_) { phones = selectedPhonesFromUi(); }
    if (!phones.length) phones = selectedPhonesFromUi();
    return { isAll, options: { scope: 'selected', phones } };
  }

  async function runBulkAction(action, options) {
    if (action.startsWith('optout')) return window.electronAPI.bulkOptOutContacts(options);
    if (action.startsWith('reoptin')) return window.electronAPI.bulkReOptInContacts(options);
    if (action.startsWith('delete')) return window.electronAPI.deleteContacts(options);
    return { success: false, error: 'Unknown bulk action.' };
  }

  document.addEventListener('click', async (event) => {
    const applyButton = event.target.closest('#apply-contact-bulk');
    if (!applyButton) return;

    // Replace the original target listener from app.js so the dropdown cannot stay in a stale state.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const dropdown = get('#contact-bulk-action');
    const action = dropdown?.value || '';
    if (!action) {
      resetBulkControls();
      return notify('Choose a bulk contact action first.', 'error');
    }

    const { isAll, options } = buildBulkOptions(action);
    if (!isAll && !options.phones.length) {
      resetBulkControls();
      return notify('Select at least one contact first.', 'error');
    }

    const warning = isAll ? 'ALL contacts matching the current search/filter' : `${options.phones.length} selected contact(s)`;
    if (action.startsWith('optout') && !confirm(`Add ${warning} to the permanent suppression list?`)) {
      resetBulkControls();
      return;
    }
    if (action.startsWith('reoptin') && !confirm(`Re-subscribe ${warning}? Only do this when those contacts expressly asked to opt in again.`)) {
      resetBulkControls();
      return;
    }
    if (action.startsWith('delete') && !confirm(`Delete ${warning} from the local contact list? This does not remove existing campaign history.`)) {
      resetBulkControls();
      return;
    }

    applyButton.disabled = true;
    if (dropdown) dropdown.disabled = true;

    try {
      const result = await runBulkAction(action, options);
      if (!result?.success) {
        notify(result?.error || 'Bulk action failed.', 'error');
        return;
      }

      await refreshContactsAfterBulk();
      notify(`Bulk action completed for ${(result.changed ?? result.removed ?? result.total ?? 0).toLocaleString()} contact(s).`);
    } catch (error) {
      notify(error?.message || 'Bulk action failed.', 'error');
    } finally {
      resetBulkControls({ clearSelection: false });
    }
  }, true);

  document.addEventListener('change', (event) => {
    if (event.target?.matches?.('#contact-bulk-action')) {
      event.target.disabled = false;
      const applyButton = get('#apply-contact-bulk');
      if (applyButton) applyButton.disabled = false;
    }
  }, true);
})();
