let dashboardChart = null;
let cachedContacts = [];
let contactsPage = 1;
let contactsTotalPages = 1;
let contactsSearchTimer = null;
let selectedRecipients = new Set();
let selectedContactPhones = new Set();
let cachedTemplates = [];
let cachedCampaigns = [];
let currentReportCampaignId = null;
let toastTimer = null;
const campaignPauseNotices = new Map();

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const formatDate = (value) => value ? new Date(value).toLocaleString() : '—';
const displayPhone = (phone) => phone ? `+${String(phone).replace(/\D/g, '')}` : '—';

function toast(message, type = 'success') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3500);
}

function openModal(id) {
  const modal = document.getElementById(id);
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}
function closeModal(id) {
  const modal = document.getElementById(id);
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

$$('[data-close]').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.close)));
$$('.modal').forEach((modal) => modal.addEventListener('click', (event) => {
  if (event.target === modal) closeModal(modal.id);
}));

$$('.nav-btn').forEach((button) => button.addEventListener('click', () => {
  $$('.nav-btn').forEach((item) => item.classList.remove('active'));
  $$('.tab').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  document.getElementById(`${button.dataset.tab}-tab`).classList.add('active');
  loadTab(button.dataset.tab);
}));

async function loadDashboard() {
  const stats = await window.electronAPI.getDashboardStats();
  for (const key of ['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped', 'optedOut']) {
    const element = document.getElementById(`stat-${key.toLowerCase()}`);
    if (element) element.textContent = stats[key] || 0;
  }
  const canvas = $('#campaign-chart');
  if (dashboardChart) dashboardChart.destroy();
  dashboardChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: ['Queued', 'Sent', 'Delivered', 'Read', 'Failed', 'Skipped', 'Opted out'],
      datasets: [{ data: [stats.queued, stats.sent, stats.delivered, stats.read, stats.failed, stats.skipped, stats.optedOut] }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
  });
}

function campaignProgress(stats) {
  if (!stats?.total) return 0;
  const done = stats.sent + stats.failed + stats.skipped + stats.optedOut;
  return Math.min(100, Math.round((done / stats.total) * 100));
}

async function loadCampaigns() {
  const campaigns = await window.electronAPI.getCampaigns();
  cachedCampaigns = campaigns;
  const list = $('#campaign-list');
  if (!campaigns.length) {
    list.innerHTML = '<div class="empty">No campaigns yet. Create a campaign after importing opted-in contacts.</div>';
    return;
  }
  list.innerHTML = campaigns.map((campaign) => {
    const stats = campaign.stats || {};
    const progress = campaignProgress(stats);
    const actions = [];
    if (['draft', 'scheduled'].includes(campaign.status)) actions.push(`<button class="btn primary small" data-action="start" data-id="${campaign._id}">Start now</button>`);
    if (campaign.status === 'active') actions.push(`<button class="btn danger small" data-action="pause" data-id="${campaign._id}">Pause</button>`);
    if (campaign.status === 'paused') actions.push(`<button class="btn primary small" data-action="resume" data-id="${campaign._id}">Resume</button>`);
    if (campaign.status !== 'completed') actions.push(`<button class="btn secondary small" data-action="limit" data-id="${campaign._id}">Change cap</button>`);
    if (campaign.status !== 'completed' && campaign.campaignLimit) actions.push(`<button class="btn secondary small" data-action="clear-limit" data-id="${campaign._id}">Clear cap</button>`);
    actions.push(`<button class="btn secondary small" data-action="report" data-id="${campaign._id}">Report</button>`);
    return `<article class="campaign-card">
      <div class="campaign-top"><div><h3>${escapeHtml(campaign.name)}</h3><p class="muted">Created ${formatDate(campaign.createdAt)}</p></div><span class="badge ${escapeHtml(campaign.status)}">${escapeHtml(campaign.status)}</span></div>
      <div class="campaign-meta"><span>${stats.total || 0} recipients</span><span>${stats.sent || 0} sent</span><span>${stats.delivered || 0} delivered</span><span>${stats.failed || 0} failed</span><span>Separate cap: ${campaign.campaignLimit ? escapeHtml(campaign.campaignLimit) : 'None (daily limit only)'}</span>${campaign.schedule ? `<span>Scheduled: ${escapeHtml(campaign.schedule)} (${escapeHtml(campaign.timezone || '')})</span>` : ''}</div>
      <div class="progress"><span data-progress="${progress}"></span></div>
      ${campaign.pauseReason ? `<p class="muted">Pause reason: ${escapeHtml(campaign.pauseReason)}</p>` : ''}
      <div class="campaign-actions">${actions.join('')}</div>
    </article>`;
  }).join('');
  $$('#campaign-list [data-progress]').forEach((bar) => { bar.style.width = `${bar.dataset.progress}%`; });
}

$('#campaign-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  button.disabled = true;
  let result;
  if (button.dataset.action === 'start') result = await window.electronAPI.startCampaign(button.dataset.id);
  if (button.dataset.action === 'pause') result = await window.electronAPI.pauseCampaign(button.dataset.id);
  if (button.dataset.action === 'resume') {
    const campaign = cachedCampaigns.find((item) => item._id === button.dataset.id);
    const usage = campaign?.usage || {};
    if (campaign?.campaignLimit && usage.remaining === 0) {
      const clearFirst = confirm(`This campaign already reached its separate cap (${usage.sent}/${campaign.campaignLimit}). Clear the separate cap and resume using only the daily limit?`);
      if (!clearFirst) { button.disabled = false; return; }
      const cleared = await window.electronAPI.setCampaignLimit(button.dataset.id, null);
      if (!cleared?.success) { toast(cleared?.error || 'Could not clear campaign cap.', 'error'); button.disabled = false; return; }
    }
    result = await window.electronAPI.resumeCampaign(button.dataset.id);
  }
  if (button.dataset.action === 'clear-limit') {
    if (!confirm('Clear the separate campaign cap and use only the global daily limit?')) { button.disabled = false; return; }
    result = await window.electronAPI.setCampaignLimit(button.dataset.id, null);
  }
  if (button.dataset.action === 'limit') {
    const campaign = cachedCampaigns.find((item) => item._id === button.dataset.id);
    const current = campaign?.campaignLimit ?? '';
    const raw = prompt(
      'Enter a separate cap for this campaign. Leave blank to clear it and use only the global daily limit.',
      current
    );
    if (raw === null) { button.disabled = false; return; }
    const trimmed = raw.trim();
    if (trimmed && (!/^\d+$/.test(trimmed) || Number(trimmed) < 1)) {
      toast('Enter a whole number of at least 1, or leave it blank to clear the separate cap.', 'error');
      button.disabled = false;
      return;
    }
    result = await window.electronAPI.setCampaignLimit(button.dataset.id, trimmed ? Number(trimmed) : null);
  }
  if (button.dataset.action === 'report') {
    await openReport(button.dataset.id);
    button.disabled = false;
    return;
  }
  if (result?.success) toast('Campaign updated.'); else toast(result?.error || 'Campaign action failed.', 'error');
  await Promise.all([loadCampaigns(), loadDashboard()]);
});

async function loadContacts() {
  const result = await window.electronAPI.getContactsPage({
    page: contactsPage,
    pageSize: 100,
    search: $('#contact-search').value,
    status: $('#contact-status-filter')?.value || ''
  });
  cachedContacts = result.contacts;
  contactsPage = result.page;
  contactsTotalPages = result.totalPages;
  $('#contact-count').textContent = `${result.total.toLocaleString()} contacts`;
  $('#contacts-page-label').textContent = `Page ${result.page} of ${result.totalPages}`;
  $('#contacts-prev').disabled = result.page <= 1;
  $('#contacts-next').disabled = result.page >= result.totalPages;
  const body = $('#contacts-body');
  if (!cachedContacts.length) {
    body.innerHTML = '<tr><td colspan="8">No matching contacts.</td></tr>';
    $('#select-visible-contacts').checked = false;
    updateSelectedContactCount();
    return;
  }
  body.innerHTML = cachedContacts.map((contact) => `<tr>
    <td><input type="checkbox" class="contact-row-check" value="${contact.phone}" ${selectedContactPhones.has(contact.phone) ? 'checked' : ''}></td>
    <td>${escapeHtml(contact.displayPhone || displayPhone(contact.phone))}</td>
    <td>${escapeHtml(contact.name || '—')}</td>
    <td>${escapeHtml(contact.email || '—')}</td>
    <td>${escapeHtml((contact.tags || []).join(', ') || '—')}</td>
    <td>${escapeHtml(contact.consentSource || '—')}<br><small>${formatDate(contact.optInDate)}</small></td>
    <td><span class="badge ${contact.optIn ? 'active' : 'paused'}">${contact.optIn ? 'Opted in' : 'Opted out'}</span></td>
    <td>${contact.optIn ? `<button class="btn danger small" data-contact-action="optout" data-phone="${contact.phone}">Opt out</button>` : `<button class="btn primary small" data-contact-action="reoptin" data-phone="${contact.phone}">Re-subscribe</button>`}</td>
  </tr>`).join('');
  $('#select-visible-contacts').checked = cachedContacts.length > 0 && cachedContacts.every((contact) => selectedContactPhones.has(contact.phone));
  updateSelectedContactCount();
}

function updateSelectedContactCount() {
  $('#selected-contact-count').textContent = `${selectedContactPhones.size.toLocaleString()} selected`;
}

$('#contacts-body').addEventListener('change', (event) => {
  const checkbox = event.target.closest('.contact-row-check');
  if (!checkbox) return;
  if (checkbox.checked) selectedContactPhones.add(checkbox.value); else selectedContactPhones.delete(checkbox.value);
  $('#select-visible-contacts').checked = cachedContacts.length > 0 && cachedContacts.every((contact) => selectedContactPhones.has(contact.phone));
  updateSelectedContactCount();
});

$('#select-visible-contacts').addEventListener('change', (event) => {
  cachedContacts.forEach((contact) => {
    if (event.target.checked) selectedContactPhones.add(contact.phone); else selectedContactPhones.delete(contact.phone);
  });
  $$('.contact-row-check').forEach((checkbox) => { checkbox.checked = event.target.checked; });
  updateSelectedContactCount();
});

$('#apply-contact-bulk').addEventListener('click', async () => {
  const action = $('#contact-bulk-action').value;
  if (!action) return toast('Choose a bulk contact action first.', 'error');
  const isAll = action.endsWith('-all');
  const options = isAll
    ? { scope: 'allMatching', search: $('#contact-search').value, status: $('#contact-status-filter').value }
    : { scope: 'selected', phones: [...selectedContactPhones] };
  if (!isAll && !selectedContactPhones.size) return toast('Select at least one contact first.', 'error');

  const warning = isAll ? 'ALL contacts matching the current search/filter' : `${selectedContactPhones.size} selected contact(s)`;
  let result;
  if (action.startsWith('optout')) {
    if (!confirm(`Add ${warning} to the permanent suppression list?`)) return;
    result = await window.electronAPI.bulkOptOutContacts(options);
  } else if (action.startsWith('reoptin')) {
    if (!confirm(`Re-subscribe ${warning}? Only do this when those contacts expressly asked to opt in again.`)) return;
    result = await window.electronAPI.bulkReOptInContacts(options);
  } else if (action.startsWith('delete')) {
    if (!confirm(`Delete ${warning} from the local contact list? This does not remove existing campaign history.`)) return;
    result = await window.electronAPI.deleteContacts(options);
  }

  if (result?.success) {
    selectedContactPhones.clear();
    $('#contact-bulk-action').value = '';
    await loadContacts();
    toast(`Bulk action completed for ${(result.changed ?? result.removed ?? result.total ?? 0).toLocaleString()} contact(s).`);
  } else {
    toast(result?.error || 'Bulk action failed.', 'error');
  }
});

$('#contacts-body').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-contact-action]');
  if (!button) return;
  if (button.dataset.contactAction === 'optout' && !confirm(`Add ${displayPhone(button.dataset.phone)} to the permanent suppression list?`)) return;
  if (button.dataset.contactAction === 'reoptin' && !confirm(`Confirm that ${displayPhone(button.dataset.phone)} has expressly asked to subscribe again?`)) return;
  const result = button.dataset.contactAction === 'optout'
    ? await window.electronAPI.optOutContact(button.dataset.phone)
    : await window.electronAPI.reOptInContact(button.dataset.phone);
  if (result.success) toast('Contact status updated.'); else toast(result.error || 'Update failed.', 'error');
  await loadContacts();
});


$('#contact-search').addEventListener('input', () => {
  clearTimeout(contactsSearchTimer);
  contactsSearchTimer = setTimeout(() => { contactsPage = 1; loadContacts(); }, 250);
});
$('#contact-status-filter').addEventListener('change', () => { contactsPage = 1; selectedContactPhones.clear(); loadContacts(); });
$('#contacts-prev').addEventListener('click', () => { if (contactsPage > 1) { contactsPage -= 1; loadContacts(); } });
$('#contacts-next').addEventListener('click', () => { if (contactsPage < contactsTotalPages) { contactsPage += 1; loadContacts(); } });

async function loadTemplates() {
  cachedTemplates = await window.electronAPI.getTemplates();
  const list = $('#template-list');
  list.innerHTML = cachedTemplates.length ? cachedTemplates.map((template) => `<article class="template-card">
    <h3>${escapeHtml(template.name)}</h3><p>${escapeHtml(template.body).replace(/\n/g, '<br>')}</p>
    <div class="button-row"><button class="btn secondary small" data-template-action="edit" data-id="${template._id}">Edit</button><button class="btn danger small" data-template-action="delete" data-id="${template._id}">Delete</button></div>
  </article>`).join('') : '<div class="empty">No saved templates.</div>';
  $('#campaign-template-select').innerHTML = '<option value="">Write a message below</option>' + cachedTemplates.map((template) => `<option value="${template._id}">${escapeHtml(template.name)}</option>`).join('');
}

$('#template-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await window.electronAPI.saveTemplate({ _id: $('#template-id').value || undefined, name: $('#template-name').value, body: $('#template-body').value });
  if (!result.success) return toast(result.error || 'Template could not be saved.', 'error');
  clearTemplateForm();
  await loadTemplates();
  toast('Template saved.');
});
function clearTemplateForm() { $('#template-id').value = ''; $('#template-name').value = ''; $('#template-body').value = ''; }
$('#clear-template').addEventListener('click', clearTemplateForm);
$('#template-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-template-action]');
  if (!button) return;
  const template = cachedTemplates.find((item) => item._id === button.dataset.id);
  if (button.dataset.templateAction === 'edit' && template) {
    $('#template-id').value = template._id; $('#template-name').value = template.name; $('#template-body').value = template.body;
  }
  if (button.dataset.templateAction === 'delete' && confirm('Delete this template?')) {
    await window.electronAPI.deleteTemplate(button.dataset.id); await loadTemplates(); toast('Template deleted.');
  }
});

async function renderRecipientList() {
  const result = await window.electronAPI.getContactsPage({
    page: 1,
    pageSize: 300,
    search: $('#recipient-search').value,
    optIn: true
  });
  const eligible = result.contacts;
  $('#recipient-list').innerHTML = eligible.length ? eligible.map((contact) => `<label class="recipient-item"><input type="checkbox" class="recipient-check" value="${contact.phone}" ${selectedRecipients.has(contact.phone) ? 'checked' : ''}><span><strong>${escapeHtml(contact.name || contact.displayPhone)}</strong><br><small>${escapeHtml(contact.displayPhone)} · ${escapeHtml((contact.tags || []).join(', ') || 'no tags')}</small></span></label>`).join('') : '<div class="empty">No matching opted-in contacts.</div>';
  $('#select-all-recipients').checked = eligible.length > 0 && eligible.every((contact) => selectedRecipients.has(contact.phone));
  updateSelectedRecipientCount();
}
function updateSelectedRecipientCount() {
  $('#selected-recipient-count').textContent = `${selectedRecipients.size.toLocaleString()} selected`;
}
function updateTargetMode() {
  const mode = $('#target-mode').value;
  $('#target-tags-wrap').classList.toggle('hidden', mode !== 'tags');
  $('#selected-target-wrap').classList.toggle('hidden', mode !== 'selected');
  if (mode === 'selected') renderRecipientList();
}

$('#new-campaign').addEventListener('click', async () => {
  await loadTemplates();
  $('#campaign-form').reset();
  selectedRecipients = new Set();
  $('#target-mode').value = 'all';
  $('#batch-size').value = '10';
  $('#batch-delay').value = '5';
  $('#campaign-limit-enabled').checked = false;
  $('#campaign-limit').value = '';
  $('#campaign-limit').disabled = true;
  $('#campaign-limit-wrap').classList.add('hidden');
  $('#campaign-timezone').value = Intl.DateTimeFormat().resolvedOptions().timeZone;
  updateTargetMode();
  openModal('campaign-modal');
});
$('#target-mode').addEventListener('change', updateTargetMode);
$('#campaign-limit-enabled').addEventListener('change', (event) => {
  const enabled = event.target.checked;
  $('#campaign-limit').disabled = !enabled;
  $('#campaign-limit-wrap').classList.toggle('hidden', !enabled);
  if (!enabled) $('#campaign-limit').value = '';
});
$('#recipient-search').addEventListener('input', () => {
  clearTimeout(contactsSearchTimer);
  contactsSearchTimer = setTimeout(renderRecipientList, 250);
});
$('#recipient-list').addEventListener('change', (event) => {
  const checkbox = event.target.closest('.recipient-check');
  if (!checkbox) return;
  if (checkbox.checked) selectedRecipients.add(checkbox.value); else selectedRecipients.delete(checkbox.value);
  updateSelectedRecipientCount();
});
$('#select-all-recipients').addEventListener('change', (event) => {
  $$('.recipient-check').forEach((checkbox) => {
    checkbox.checked = event.target.checked;
    if (event.target.checked) selectedRecipients.add(checkbox.value); else selectedRecipients.delete(checkbox.value);
  });
  updateSelectedRecipientCount();
});
$('#campaign-template-select').addEventListener('change', (event) => {
  const template = cachedTemplates.find((item) => item._id === event.target.value);
  if (template) $('#campaign-message').value = template.body;
});

$('#campaign-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const targetMode = $('#target-mode').value;
  const contacts = targetMode === 'selected' ? [...selectedRecipients] : [];
  const tags = targetMode === 'tags' ? $('#target-tags').value.split(',').map((tag) => tag.trim()).filter(Boolean) : [];
  if (targetMode === 'selected' && !contacts.length) return toast('Select at least one opted-in recipient.', 'error');
  if (targetMode === 'tags' && !tags.length) return toast('Enter at least one target tag.', 'error');
  if ($('#campaign-limit-enabled').checked && Number($('#campaign-limit').value) < 1) {
    return toast('Enter the separate campaign cap, or turn the separate cap off.', 'error');
  }
  const result = await window.electronAPI.createCampaign({
    name: $('#campaign-name').value,
    messageTemplate: $('#campaign-message').value,
    mediaUrl: $('#media-url').value,
    batchSize: Number($('#batch-size').value),
    batchDelayMs: Number($('#batch-delay').value) * 60000,
    campaignLimit: $('#campaign-limit-enabled').checked ? (Number($('#campaign-limit').value) || null) : null,
    schedule: $('#campaign-schedule').value.trim(),
    timezone: $('#campaign-timezone').value,
    contacts,
    tags
  });
  if (!result.success) return toast(result.error || 'Campaign could not be created.', 'error');
  event.target.reset();
  closeModal('campaign-modal');
  await Promise.all([loadCampaigns(), loadDashboard()]);
  toast('Campaign created. Scheduled campaigns run once at the next matching time.');
});

$('#open-import').addEventListener('click', () => openModal('import-modal'));
$('#import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await window.electronAPI.selectImportContacts({
    defaultCountryCode: $('#default-country-code').value,
    consentSource: $('#consent-source').value,
    consentEvidence: $('#consent-evidence').value,
    consentConfirmed: $('#consent-confirmed').checked
  });
  if (result.canceled) return;
  if (!result.success) return toast(result.error || 'Import failed.', 'error');
  closeModal('import-modal');
  await loadContacts();
  toast(`Imported ${result.imported}, updated ${result.updated}, skipped ${result.skipped}.`);
});

async function loadLogs() {
  const logs = await window.electronAPI.getLogs({ level: $('#log-level').value, limit: 250 });
  $('#logs-container').innerHTML = logs.length ? logs.map((log) => `<div class="log-entry ${escapeHtml(log.level)}">[${formatDate(log.timestamp)}] ${escapeHtml(log.level.toUpperCase())}: ${escapeHtml(log.message)}</div>`).join('') : '<div class="log-entry">No matching logs.</div>';
}
$('#refresh-logs').addEventListener('click', loadLogs);
$('#log-level').addEventListener('change', loadLogs);

async function loadSettings() {
  const settings = await window.electronAPI.getSafetySettings();
  $('#daily-limit').value = settings.dailyLimit;
  $('#failure-rate').value = Math.round(settings.maxFailureRate * 100);
  $('#failure-sample').value = settings.minFailureSample;
  $('#min-delay').value = settings.minMessageDelayMs / 1000;
  $('#max-delay').value = settings.maxMessageDelayMs / 1000;
  $('#max-retries').value = settings.maxRetries;
  $('#retry-delay').value = settings.retryDelayMs / 1000;
  $('#daily-count').textContent = settings.dailyCount;
  $('#daily-remaining').textContent = settings.dailyRemaining;
  $('#resume-sending').classList.toggle('hidden', !settings.emergencyPaused);
}
$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await window.electronAPI.updateSafetySettings({
    dailyLimit: Number($('#daily-limit').value),
    maxFailureRate: Number($('#failure-rate').value) / 100,
    minFailureSample: Number($('#failure-sample').value),
    minMessageDelayMs: Number($('#min-delay').value) * 1000,
    maxMessageDelayMs: Number($('#max-delay').value) * 1000,
    maxRetries: Number($('#max-retries').value),
    retryDelayMs: Number($('#retry-delay').value) * 1000
  });
  if (result.success) { await loadSettings(); toast('Safety settings saved.'); }
});

$('#emergency-pause').addEventListener('click', async () => {
  if (!confirm('Pause all active campaigns immediately?')) return;
  await window.electronAPI.emergencyPause();
  await Promise.all([loadSettings(), loadCampaigns()]);
  toast('Emergency pause activated.', 'error');
});
$('#resume-sending').addEventListener('click', async () => {
  await window.electronAPI.resumeSending();
  await loadSettings();
  toast('Emergency pause cleared. Resume campaigns individually after review.');
});

function updateWhatsAppStatus(payload) {
  const status = typeof payload === 'string' ? payload : payload?.status || 'disconnected';
  const details = typeof payload === 'object' ? payload.details : '';
  const connected = status === 'connected';
  const waiting = ['initializing', 'loading', 'qr_required', 'authenticated'].includes(status);
  $('#side-status-dot').classList.toggle('connected', connected);
  $('#side-status-dot').classList.toggle('waiting', waiting);
  const label = status.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  $('#side-status-text').textContent = label;
  $('#wa-connection-title').textContent = label;
  $('#wa-connection-detail').textContent = details || (connected ? 'Ready to send approved campaigns.' : 'Press Connect to display the linking QR code.');
  $('#connect-whatsapp').disabled = connected || waiting;
  if (connected) closeModal('qr-modal');
  if (status === 'auth_failure' || status === 'error') toast(details || 'WhatsApp connection failed.', 'error');
}

$('#connect-whatsapp').addEventListener('click', async () => {
  $('#qr-image').classList.add('hidden');
  $('#qr-spinner').classList.remove('hidden');
  $('#qr-message').textContent = 'Starting WhatsApp and waiting for a QR code…';
  openModal('qr-modal');
  const result = await window.electronAPI.connectWhatsApp();
  if (!result.success) toast(result.error || 'Connection could not be started.', 'error');
});
$('#disconnect-whatsapp').addEventListener('click', async () => { await window.electronAPI.disconnectWhatsApp(); toast('WhatsApp disconnected.'); });
$('#logout-whatsapp').addEventListener('click', async () => {
  if (!confirm('Log out and require a new QR scan next time?')) return;
  const result = await window.electronAPI.logoutWhatsApp();
  if (result.success) toast('WhatsApp session logged out.'); else toast(result.error, 'error');
});
window.electronAPI.onQRCode((payload) => {
  $('#qr-image').src = payload.dataUrl;
  $('#qr-image').classList.remove('hidden');
  $('#qr-spinner').classList.add('hidden');
  $('#qr-message').textContent = 'Scan this code. It refreshes automatically if it expires.';
  openModal('qr-modal');
});
window.electronAPI.onWhatsAppStatus(updateWhatsAppStatus);
window.electronAPI.onCampaignUpdate(async (payload) => {
  const campaign = payload?.campaign;
  if (campaign?.status === 'paused' && campaign.pauseReason) {
    const previous = campaignPauseNotices.get(campaign._id);
    if (previous !== campaign.pauseReason) {
      campaignPauseNotices.set(campaign._id, campaign.pauseReason);
      toast(`Campaign paused: ${campaign.pauseReason}`, 'error');
    }
  }
  if (campaign?.status === 'active') campaignPauseNotices.delete(campaign._id);
  const campaignsVisible = $('#campaigns-tab').classList.contains('active');
  if (campaignsVisible) await loadCampaigns();
  await loadDashboard();
});
window.electronAPI.onContactUpdate(async () => {
  if ($('#contacts-tab').classList.contains('active')) await loadContacts();
  toast('A WhatsApp subscription preference was updated.');
});

async function openReport(campaignId) {
  currentReportCampaignId = campaignId;
  const [rows, details] = await Promise.all([
    window.electronAPI.getRecipientReport(campaignId),
    window.electronAPI.getCampaignDetails(campaignId)
  ]);
  const cap = details?.campaignLimit ? `${details.usage.sent}/${details.campaignLimit}` : 'None (daily limit only)';
  const daily = details?.daily ? `${details.daily.sent}/${details.daily.limit}` : '—';
  const pause = details?.pauseReason ? ` · Pause reason: ${details.pauseReason}` : '';
  $('#report-summary').textContent = `${rows.length} recipient records · Separate campaign cap: ${cap} · Daily usage: ${daily}${pause}`;
  $('#report-body').innerHTML = rows.map((row) => `<tr><td>${escapeHtml(displayPhone(row.phone))}</td><td>${escapeHtml(row.status)}</td><td>${row.attempts || 0}</td><td>${escapeHtml(row.ack || '—')}</td><td>${escapeHtml(row.lastError || '—')}</td></tr>`).join('');
  openModal('report-modal');
}
$('#export-report').addEventListener('click', async () => {
  if (!currentReportCampaignId) return;
  const result = await window.electronAPI.exportCampaignReport(currentReportCampaignId);
  if (result.success) toast('Campaign report exported.');
});

function loadTab(tab) {
  if (tab === 'dashboard') loadDashboard();
  if (tab === 'campaigns') loadCampaigns();
  if (tab === 'contacts') loadContacts();
  if (tab === 'templates') loadTemplates();
  if (tab === 'logs') loadLogs();
  if (tab === 'settings') loadSettings();
}

$('#refresh-dashboard').addEventListener('click', loadDashboard);

document.addEventListener('DOMContentLoaded', async () => {
  const status = await window.electronAPI.getWhatsAppStatus();
  updateWhatsAppStatus(status);
  await Promise.all([loadDashboard(), loadSettings()]);
});
