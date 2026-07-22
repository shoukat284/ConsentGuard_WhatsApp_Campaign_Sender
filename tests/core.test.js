const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizePhone } = require('../src/modules/utils');
const { Logger } = require('../src/modules/logger');
const { ContactManager } = require('../src/modules/contactManager');
const { SafetyGuard } = require('../src/modules/safetyGuard');
const { CampaignManager } = require('../src/modules/campaignManager');

async function makeEnvironment() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consentguard-'));
  const logger = new Logger(dir);
  await logger.initialize();
  const contacts = new ContactManager(logger, dir);
  const safety = new SafetyGuard(logger, dir);
  await contacts.initialize();
  await safety.initialize();
  return { dir, logger, contacts, safety };
}

async function waitFor(predicate, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition');
}

test('normalizes E.164 and local numbers without storing a plus sign', () => {
  assert.equal(normalizePhone('+92 300 1234567'), '923001234567');
  assert.equal(normalizePhone('03001234567', '92'), '923001234567');
  assert.equal(normalizePhone('123'), null);
});

test('contact import requires consent and permanent suppression wins', async () => {
  const { dir, contacts } = await makeEnvironment();
  const csv = path.join(dir, 'contacts.csv');
  fs.writeFileSync(csv, 'phone,name,opt_in\n03001234567,Ali,yes\n03007654321,Sara,yes\n');

  const denied = await contacts.importContacts(csv, { defaultCountryCode: '92', consentSource: 'Website', consentConfirmed: false });
  assert.equal(denied.success, false);

  const imported = await contacts.importContacts(csv, { defaultCountryCode: '92', consentSource: 'Website', consentConfirmed: true });
  assert.equal(imported.imported, 2);

  await contacts.optOutContact('923001234567', 'STOP', 'test');
  const second = await contacts.importContacts(csv, { defaultCountryCode: '92', consentSource: 'Website', consentConfirmed: true });
  assert.equal(second.skipped >= 1, true);
  assert.equal(await contacts.isOptedOut('923001234567'), true);
});

test('failure-rate pause starts only after the configured sample', async () => {
  const { safety } = await makeEnvironment();
  await safety.updateSettings({ maxFailureRate: 0.30, minFailureSample: 2, minMessageDelayMs: 0, maxMessageDelayMs: 0 });
  await safety.recordFailure('campaign-a');
  await safety.canSendMessage('campaign-a');
  await safety.recordFailure('campaign-a');
  await assert.rejects(() => safety.canSendMessage('campaign-a'), /FAILURE_RATE_HIGH/);
});

test('campaign sends each recipient once and completed campaigns cannot resume', async () => {
  const { dir, logger, contacts, safety } = await makeEnvironment();
  await safety.updateSettings({ minMessageDelayMs: 0, maxMessageDelayMs: 0, retryDelayMs: 500, maxRetries: 0 });
  const now = new Date();
  await contacts.db.insert({ phone: '923001111111', name: 'One', email: '', tags: [], optIn: true, optInDate: now, consentSource: 'Test', createdAt: now, updatedAt: now });
  await contacts.db.insert({ phone: '923002222222', name: 'Two', email: '', tags: [], optIn: true, optInDate: now, consentSource: 'Test', createdAt: now, updatedAt: now });

  const calls = [];
  const sender = {
    getStatus: () => ({ status: 'connected' }),
    processTemplate: (template, contact) => template.replace('{{name}}', contact.name),
    sendWithRetry: async (phone, text, _media, _campaign, _guardOptions, onAttempt) => {
      if (onAttempt) await onAttempt(1);
      calls.push({ phone, text });
      return { messageId: `id-${phone}` };
    }
  };

  const manager = new CampaignManager(contacts, sender, safety, logger, dir);
  await manager.initialize();
  const created = await manager.createCampaign({
    name: 'Test campaign',
    messageTemplate: 'Hello {{name}}',
    contacts: ['923001111111', '923002222222'],
    batchSize: 2,
    batchDelayMs: 0
  });
  assert.equal(created.success, true);
  assert.equal((await manager.startCampaign(created.campaignId)).success, true);

  await waitFor(async () => (await manager.campaignDb.findOne({ _id: created.campaignId })).status === 'completed');
  assert.equal(calls.length, 2);
  assert.equal((await manager.getCampaignStats(created.campaignId)).sent, 2);
  assert.equal((await manager.resumeCampaign(created.campaignId)).success, false);

  const duplicate = await manager.createCampaign({
    name: 'Another name',
    messageTemplate: 'Hello {{name}}',
    contacts: ['923001111111', '923002222222']
  });
  assert.equal(duplicate.success, false);
  await manager.destroy();
});

test('contact pagination and search return bounded results', async () => {
  const { contacts } = await makeEnvironment();
  const now = new Date();
  for (let i = 0; i < 25; i += 1) {
    await contacts.db.insert({
      phone: `92300${String(1000000 + i)}`,
      name: i === 17 ? 'Special Customer' : `Customer ${i}`,
      email: '', tags: i % 2 ? ['vip'] : ['standard'], optIn: true,
      optInDate: now, consentSource: 'Test', createdAt: new Date(now.getTime() + i), updatedAt: now
    });
  }
  const page = await contacts.getContactsPage({ page: 2, pageSize: 10 });
  assert.equal(page.contacts.length, 10);
  assert.equal(page.total, 25);
  assert.equal(page.totalPages, 3);
  const search = await contacts.getContactsPage({ search: 'Special', pageSize: 10 });
  assert.equal(search.total, 1);
  assert.equal(search.contacts[0].name, 'Special Customer');
});

test('restart recovery never automatically resends an uncertain in-flight recipient', async () => {
  const { dir, logger, contacts, safety } = await makeEnvironment();
  const sender = { getStatus: () => ({ status: 'connected' }) };
  const manager = new CampaignManager(contacts, sender, safety, logger, dir);
  const campaign = await manager.campaignDb.insert({ name: 'Interrupted', status: 'active', createdAt: new Date(), updatedAt: new Date() });
  await manager.recipientDb.insert({
    recipientKey: `${campaign._id}:923001234567`, campaignId: campaign._id, phone: '923001234567',
    order: 0, status: 'sending', attempts: 1, createdAt: new Date(), updatedAt: new Date()
  });
  await manager.initialize();
  const recoveredCampaign = await manager.campaignDb.findOne({ _id: campaign._id });
  const recoveredRecipient = await manager.recipientDb.findOne({ campaignId: campaign._id });
  assert.equal(recoveredCampaign.status, 'paused');
  assert.equal(recoveredRecipient.status, 'skipped');
  assert.match(recoveredRecipient.lastError, /not resent automatically/i);
  await manager.destroy();
});


test('daily limit and optional campaign cap are independent', async () => {
  const { dir, logger, contacts, safety } = await makeEnvironment();
  await safety.updateSettings({ dailyLimit: 100, minMessageDelayMs: 0, maxMessageDelayMs: 0, maxRetries: 3 });
  const now = new Date();
  const phones = [];
  for (let i = 0; i < 5; i += 1) {
    const phone = `92300900000${i}`;
    phones.push(phone);
    await contacts.db.insert({ phone, name: `Contact ${i}`, email: '', tags: [], optIn: true, optInDate: now, consentSource: 'Test', createdAt: now, updatedAt: now });
  }

  const calls = [];
  const sender = {
    getStatus: () => ({ status: 'connected' }),
    processTemplate: (template) => template,
    sendWithRetry: async (phone, text, _media, _campaign, _guardOptions, onAttempt) => {
      if (onAttempt) await onAttempt(1);
      calls.push({ phone, text });
      return { messageId: `id-${phone}` };
    }
  };

  const manager = new CampaignManager(contacts, sender, safety, logger, dir);
  await manager.initialize();
  const created = await manager.createCampaign({
    name: 'Uncapped campaign', messageTemplate: 'Hello', contacts: phones,
    batchSize: 5, batchDelayMs: 0, campaignLimit: null
  });
  assert.equal(created.success, true);
  assert.equal((await manager.startCampaign(created.campaignId)).success, true);
  await waitFor(async () => (await manager.campaignDb.findOne({ _id: created.campaignId })).status === 'completed');
  assert.equal(calls.length, 5);
  assert.equal((await safety.getCampaignUsage(created.campaignId)).limit, null);
  assert.equal((await safety.getSettings()).dailyCount, 5);
  await manager.destroy();
});

test('campaign cap can be cleared and paused recipients resume without a false attempt', async () => {
  const { dir, logger, contacts, safety } = await makeEnvironment();
  await safety.updateSettings({ dailyLimit: 100, minMessageDelayMs: 0, maxMessageDelayMs: 0, maxRetries: 0 });
  const now = new Date();
  const phones = [];
  for (let i = 0; i < 5; i += 1) {
    const phone = `92300800000${i}`;
    phones.push(phone);
    await contacts.db.insert({ phone, name: `Contact ${i}`, email: '', tags: [], optIn: true, optInDate: now, consentSource: 'Test', createdAt: now, updatedAt: now });
  }

  const sender = {
    getStatus: () => ({ status: 'connected' }),
    processTemplate: (template) => template,
    sendWithRetry: async (phone, _text, _media, campaignId, guardOptions, onAttempt) => {
      await safety.canSendMessage(campaignId, guardOptions);
      if (onAttempt) await onAttempt(1);
      return { messageId: `id-${phone}` };
    }
  };

  const manager = new CampaignManager(contacts, sender, safety, logger, dir);
  await manager.initialize();
  const created = await manager.createCampaign({
    name: 'Capped campaign', messageTemplate: 'Hello', contacts: phones,
    batchSize: 5, batchDelayMs: 0, campaignLimit: 3
  });
  assert.equal(created.success, true);
  assert.equal((await manager.startCampaign(created.campaignId)).success, true);
  await waitFor(async () => (await manager.campaignDb.findOne({ _id: created.campaignId })).status === 'paused');

  const pausedRows = await manager.getRecipientReport(created.campaignId);
  assert.equal(pausedRows.filter((row) => row.status === 'sent').length, 3);
  const blocked = pausedRows.find((row) => row.lastError && row.lastError.includes('CAMPAIGN_LIMIT_REACHED'));
  assert.ok(blocked);
  assert.equal(blocked.attempts, 0);

  const cleared = await manager.updateCampaignLimit(created.campaignId, null);
  assert.equal(cleared.success, true);
  assert.equal(cleared.campaignLimit, null);
  assert.equal((await manager.resumeCampaign(created.campaignId)).success, true);
  await waitFor(async () => (await manager.campaignDb.findOne({ _id: created.campaignId })).status === 'completed');
  assert.equal((await manager.getCampaignStats(created.campaignId)).sent, 5);
  assert.equal((await safety.getSettings()).dailyCount, 5);
  await manager.destroy();
});

test('start repairs stale daily and campaign counters from the recipient ledger', async () => {
  const { dir, logger, contacts, safety } = await makeEnvironment();
  await safety.updateSettings({ dailyLimit: 100, minMessageDelayMs: 0, maxMessageDelayMs: 0, maxRetries: 0 });
  const now = new Date();
  const phones = [];
  for (let i = 0; i < 5; i += 1) {
    const phone = `92300700000${i}`;
    phones.push(phone);
    await contacts.db.insert({ phone, name: `Contact ${i}`, email: '', tags: [], optIn: true, optInDate: now, consentSource: 'Test', createdAt: now, updatedAt: now });
  }

  const calls = [];
  const sender = {
    getStatus: () => ({ status: 'connected' }),
    verifyConnection: async () => true,
    processTemplate: (template) => template,
    sendWithRetry: async (phone, _text, _media, _campaign, _guardOptions, onAttempt) => {
      if (onAttempt) await onAttempt(1);
      calls.push(phone);
      return { messageId: `id-${phone}` };
    }
  };

  const manager = new CampaignManager(contacts, sender, safety, logger, dir);
  await manager.initialize();
  const created = await manager.createCampaign({
    name: 'Repair stale counters', messageTemplate: 'Hello', contacts: phones,
    batchSize: 5, batchDelayMs: 0, campaignLimit: null
  });
  assert.equal(created.success, true);

  const rows = await manager.getRecipientReport(created.campaignId);
  for (const row of rows.slice(0, 3)) {
    await manager.recipientDb.update({ _id: row._id }, {
      $set: { status: 'sent', attempts: 1, sentAt: now, messageId: `old-${row.phone}`, updatedAt: now }
    });
  }

  await safety.reconcileDailyCount(100);
  await safety.reconcileCampaignCounter(created.campaignId, { sent: 100, attempts: 100, failures: 40, limit: 3 });

  const started = await manager.startCampaign(created.campaignId);
  assert.equal(started.success, true);
  await waitFor(async () => (await manager.campaignDb.findOne({ _id: created.campaignId })).status === 'completed');

  assert.equal(calls.length, 2);
  const settings = await safety.getSettings();
  const usage = await safety.getCampaignUsage(created.campaignId);
  assert.equal(settings.dailyCount, 5);
  assert.equal(usage.sent, 5);
  assert.equal(usage.failures, 0);
  assert.equal(usage.limit, null);
  await manager.destroy();
});

test('pause and immediate resume do not leave a sleeping or duplicate campaign worker', async () => {
  const { dir, logger, contacts, safety } = await makeEnvironment();
  await safety.updateSettings({ dailyLimit: 100, minMessageDelayMs: 0, maxMessageDelayMs: 0, maxRetries: 0 });
  const now = new Date();
  const phones = ['923006000001', '923006000002'];
  for (const phone of phones) {
    await contacts.db.insert({ phone, name: phone, email: '', tags: [], optIn: true, optInDate: now, consentSource: 'Test', createdAt: now, updatedAt: now });
  }

  const calls = [];
  const sender = {
    getStatus: () => ({ status: 'connected' }),
    verifyConnection: async () => true,
    processTemplate: (template) => template,
    sendWithRetry: async (phone, _text, _media, _campaign, _guardOptions, onAttempt) => {
      if (onAttempt) await onAttempt(1);
      calls.push(phone);
      return { messageId: `id-${phone}` };
    }
  };

  const manager = new CampaignManager(contacts, sender, safety, logger, dir);
  await manager.initialize();
  const created = await manager.createCampaign({
    name: 'Pause resume race', messageTemplate: 'Hello', contacts: phones,
    batchSize: 1, batchDelayMs: 5000
  });
  assert.equal((await manager.startCampaign(created.campaignId)).success, true);
  await waitFor(async () => (await manager.getCampaignStats(created.campaignId)).sent === 1);
  await manager.pauseCampaign(created.campaignId, 'Test pause');
  assert.equal((await manager.resumeCampaign(created.campaignId)).success, true);
  await waitFor(async () => (await manager.campaignDb.findOne({ _id: created.campaignId })).status === 'completed', 5000);

  assert.deepEqual(calls.sort(), phones.sort());
  assert.equal(calls.length, 2);
  await manager.destroy();
});

test('bulk contact actions opt out selected and delete matching contacts', async () => {
  const { contacts } = await makeEnvironment();
  const now = new Date();
  await contacts.db.insert({ phone: '923005551111', name: 'Bulk One', email: '', tags: ['bulk'], optIn: true, optInDate: now, consentSource: 'Test', createdAt: now, updatedAt: now });
  await contacts.db.insert({ phone: '923005552222', name: 'Bulk Two', email: '', tags: ['bulk'], optIn: true, optInDate: now, consentSource: 'Test', createdAt: now, updatedAt: now });
  await contacts.db.insert({ phone: '923005553333', name: 'Keep Three', email: '', tags: ['keep'], optIn: true, optInDate: now, consentSource: 'Test', createdAt: now, updatedAt: now });

  const opted = await contacts.bulkOptOutContacts({ scope: 'selected', phones: ['923005551111', '923005552222'] });
  assert.equal(opted.success, true);
  assert.equal(opted.changed, 2);
  assert.equal(await contacts.isOptedOut('923005551111'), true);
  assert.equal((await contacts.getContactsPage({ status: 'optedOut' })).total, 2);

  const deleted = await contacts.deleteContacts({ scope: 'allMatching', search: 'Keep' });
  assert.equal(deleted.success, true);
  assert.equal(deleted.removed, 1);
  assert.equal((await contacts.getContactsPage({})).total, 2);
});

test('resume refuses an already reached separate cap before activating worker', async () => {
  const { dir, logger, contacts, safety } = await makeEnvironment();
  await safety.updateSettings({ dailyLimit: 250, minMessageDelayMs: 0, maxMessageDelayMs: 0, maxRetries: 0 });
  const now = new Date();
  const phones = ['923004440001', '923004440002', '923004440003', '923004440004'];
  for (const phone of phones) {
    await contacts.db.insert({ phone, name: phone, email: '', tags: [], optIn: true, optInDate: now, consentSource: 'Test', createdAt: now, updatedAt: now });
  }
  const sender = {
    getStatus: () => ({ status: 'connected' }),
    verifyConnection: async () => true,
    processTemplate: (template) => template,
    sendWithRetry: async () => ({ messageId: 'unused' })
  };
  const manager = new CampaignManager(contacts, sender, safety, logger, dir);
  await manager.initialize();
  const created = await manager.createCampaign({ name: 'Cap reached', messageTemplate: 'Hello', contacts: phones, batchSize: 4, batchDelayMs: 0, campaignLimit: 3 });
  assert.equal(created.success, true);
  const rows = await manager.getRecipientReport(created.campaignId);
  for (const row of rows.slice(0, 3)) {
    await manager.recipientDb.update({ _id: row._id }, { $set: { status: 'sent', attempts: 1, sentAt: now, updatedAt: now } });
  }
  await manager.campaignDb.update({ _id: created.campaignId }, { $set: { status: 'paused', pauseReason: 'CAMPAIGN_LIMIT_REACHED: Separate campaign cap reached (3/3)' } });

  const resumed = await manager.resumeCampaign(created.campaignId);
  assert.equal(resumed.success, false);
  assert.match(resumed.error, /Clear cap/);
  assert.equal((await manager.campaignDb.findOne({ _id: created.campaignId })).status, 'paused');
  await manager.destroy();
});
