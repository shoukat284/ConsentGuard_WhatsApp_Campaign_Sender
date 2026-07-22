const Datastore = require('nedb-promises');
const path = require('path');
const cron = require('node-cron');
const { stableHash, normalizePhone, sleep, randomBetween, sanitizeText, localDayBounds, withTimeout } = require('./utils');

const ACK_LABELS = {
  '-1': 'error',
  0: 'pending',
  1: 'server',
  2: 'delivered',
  3: 'read',
  4: 'played'
};

class CampaignManager {
  constructor(contactManager, messageSender, safetyGuard, logger, dataDir) {
    this.contactManager = contactManager;
    this.messageSender = messageSender;
    this.safetyGuard = safetyGuard;
    this.logger = logger;
    this.campaignDb = Datastore.create({ filename: path.join(dataDir, 'campaigns.db'), autoload: true });
    this.recipientDb = Datastore.create({ filename: path.join(dataDir, 'campaign_recipients.db'), autoload: true });
    this.activeCampaigns = new Map();
    this.scheduledTasks = new Map();
    this.updateCallback = null;
    this.pendingAcks = new Map();
    this.processorPromises = new Map();
  }

  async initialize() {
    await this.campaignDb.ensureIndex({ fieldName: 'fingerprint', unique: true, sparse: true });
    await this.recipientDb.ensureIndex({ fieldName: 'recipientKey', unique: true });
    await this.recipientDb.ensureIndex({ fieldName: 'messageId', sparse: true });
    await this.restoreSchedules();
    await this.recipientDb.update(
      { status: 'sending' },
      { $set: { status: 'skipped', lastError: 'Uncertain send state after application restart; not resent automatically.', updatedAt: new Date() } },
      { multi: true }
    );
    const active = await this.campaignDb.find({ status: 'active' });
    for (const campaign of active) {
      await this.campaignDb.update({ _id: campaign._id }, {
        $set: { status: 'paused', pauseReason: 'Application restarted; review and resume safely.', updatedAt: new Date() }
      });
    }

    // Recipient ledgers are the source of truth. Repair stale counters left by older versions.
    await this.reconcileSafetyCounters();
  }


  async reconcileSafetyCounters(campaignId = null) {
    const { start, end } = localDayBounds();
    const dailySent = await this.recipientDb.count({ status: 'sent', sentAt: { $gte: start, $lt: end } });
    await this.safetyGuard.reconcileDailyCount(dailySent);

    const query = campaignId ? { _id: campaignId } : {};
    const campaigns = await this.campaignDb.find(query);
    for (const campaign of campaigns) {
      const [sent, failures] = await Promise.all([
        this.recipientDb.count({ campaignId: campaign._id, status: 'sent' }),
        this.recipientDb.count({ campaignId: campaign._id, status: 'failed' })
      ]);
      await this.safetyGuard.reconcileCampaignCounter(campaign._id, {
        sent,
        failures,
        attempts: sent + failures,
        limit: campaign.campaignLimit
      });
    }
    return { dailySent, campaigns: campaigns.length };
  }

  async waitForPreviousProcessor(campaignId) {
    const existing = this.processorPromises.get(campaignId);
    if (!existing) return;
    const token = this.activeCampaigns.get(campaignId);
    if (token) token.stopped = true;
    try {
      await withTimeout(existing, 10000, 'Previous campaign worker did not stop within 10 seconds');
    } catch (error) {
      await this.logger.log('error', `Previous campaign worker could not stop safely: ${error.message}`, { campaignId });
      throw new Error('The previous campaign worker is still stopping. Wait a few seconds and press Resume again.');
    }
  }

  async controlledSleep(ms, token) {
    let remaining = Math.max(0, Number(ms) || 0);
    while (remaining > 0) {
      if (token.stopped) return false;
      const slice = Math.min(250, remaining);
      await sleep(slice);
      remaining -= slice;
    }
    return !token.stopped;
  }

  onUpdate(callback) { this.updateCallback = callback; }
  async emitUpdate(campaignId) {
    if (!this.updateCallback) return;
    const [campaign, stats] = await Promise.all([
      this.campaignDb.findOne({ _id: campaignId }),
      this.getCampaignStats(campaignId)
    ]);
    this.updateCallback({ campaign, stats });
  }

  async createCampaign(data) {
    let savedCampaign = null;
    try {
      const name = sanitizeText(data.name, 200);
      const messageTemplate = sanitizeText(data.messageTemplate, 10000);
      if (!name || !messageTemplate) throw new Error('Campaign name and message are required.');

      const requestedPhones = [...new Set((data.contacts || []).map((phone) => normalizePhone(phone)).filter(Boolean))];
      const eligible = await this.contactManager.getEligibleContacts({ phones: requestedPhones, tags: data.tags || [] });
      const contacts = eligible.map((contact) => contact.phone);
      if (!contacts.length) throw new Error('No opted-in, non-suppressed contacts were selected.');

      const schedule = sanitizeText(data.schedule, 100);
      if (schedule && !cron.validate(schedule)) throw new Error('The schedule is not a valid cron expression.');

      const fingerprint = stableHash({
        messageTemplate,
        mediaUrl: data.mediaUrl || null,
        contacts: [...contacts].sort()
      });
      const duplicate = await this.campaignDb.findOne({ fingerprint });
      if (duplicate) {
        throw new Error(`Duplicate campaign blocked. The same message and recipients already exist in “${duplicate.name}”.`);
      }

      const now = new Date();
      const campaign = await this.campaignDb.insert({
        name,
        messageTemplate,
        mediaUrl: sanitizeText(data.mediaUrl, 2000) || null,
        schedule: schedule || null,
        timezone: sanitizeText(data.timezone, 100) || Intl.DateTimeFormat().resolvedOptions().timeZone,
        batchSize: Math.min(100, Math.max(1, Number(data.batchSize) || 10)),
        batchDelayMs: Math.max(0, Number(data.batchDelayMs ?? data.batchDelay) || 300000),
        campaignLimit: Number(data.campaignLimit) > 0 ? Number(data.campaignLimit) : null,
        fingerprint,
        status: schedule ? 'scheduled' : 'draft',
        pauseReason: null,
        createdAt: now,
        updatedAt: now
      });
      savedCampaign = campaign;

      for (let order = 0; order < contacts.length; order += 1) {
        const phone = contacts[order];
        await this.recipientDb.insert({
          recipientKey: `${campaign._id}:${phone}`,
          campaignId: campaign._id,
          phone,
          order,
          status: 'queued',
          attempts: 0,
          messageId: null,
          ack: null,
          lastError: null,
          createdAt: now,
          updatedAt: now
        });
      }

      await this.safetyGuard.setCampaignLimit(campaign._id, campaign.campaignLimit, { silent: true });
      if (schedule) this.registerSchedule(campaign);
      await this.logger.log('info', `Campaign created: ${name}`, { campaignId: campaign._id, recipients: contacts.length });
      return { success: true, campaignId: campaign._id };
    } catch (error) {
      if (savedCampaign) {
        await this.recipientDb.remove({ campaignId: savedCampaign._id }, { multi: true });
        await this.campaignDb.remove({ _id: savedCampaign._id }, {});
      }
      await this.logger.log('error', `Campaign creation failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  registerSchedule(campaign) {
    this.unregisterSchedule(campaign._id);
    if (!campaign.schedule || !cron.validate(campaign.schedule)) return;
    const task = cron.schedule(campaign.schedule, async () => {
      this.unregisterSchedule(campaign._id);
      await this.startCampaign(campaign._id, 'schedule');
    }, { timezone: campaign.timezone || undefined });
    this.scheduledTasks.set(campaign._id, task);
  }

  unregisterSchedule(campaignId) {
    const task = this.scheduledTasks.get(campaignId);
    if (task) {
      task.stop();
      if (typeof task.destroy === 'function') task.destroy();
      this.scheduledTasks.delete(campaignId);
    }
  }

  async restoreSchedules() {
    const campaigns = await this.campaignDb.find({ status: 'scheduled' });
    for (const campaign of campaigns) this.registerSchedule(campaign);
  }

  async startCampaign(campaignId, source = 'manual') {
    try {
      if (this.messageSender.getStatus().status !== 'connected') throw new Error('Connect WhatsApp before starting the campaign.');
      if (typeof this.messageSender.verifyConnection === 'function') await this.messageSender.verifyConnection();
      const safety = await this.safetyGuard.getSettings();
      if (safety.emergencyPaused) throw new Error('Emergency pause is active. Resume sending first.');
      const campaign = await this.campaignDb.findOne({ _id: campaignId });
      if (!campaign) throw new Error('Campaign not found.');
      const otherActive = await this.campaignDb.findOne({ status: 'active', _id: { $ne: campaignId } });
      if (otherActive) throw new Error(`Another campaign is active: “${otherActive.name}”. Pause or complete it first.`);
      if (campaign.status === 'completed') throw new Error('Completed campaigns cannot be resent. Create a new campaign instead.');
      await this.waitForPreviousProcessor(campaignId);

      // Repair counters from the recipient ledger before every start/resume.
      await this.reconcileSafetyCounters(campaignId);
      await this.safetyGuard.setCampaignLimit(campaignId, campaign.campaignLimit, { silent: true });
      const preflightUsage = await this.safetyGuard.getCampaignUsage(campaignId, campaign.campaignLimit);
      if (Number.isFinite(preflightUsage.limit) && preflightUsage.sent >= preflightUsage.limit) {
        throw new Error(`CAMPAIGN_LIMIT_REACHED: Separate campaign cap is already reached (${preflightUsage.sent}/${preflightUsage.limit}). Press Clear cap, or set a higher cap, before resuming.`);
      }
      await this.safetyGuard.canSendMessage(campaignId, { campaignLimit: campaign.campaignLimit });
      this.unregisterSchedule(campaignId);
      await this.campaignDb.update({ _id: campaignId }, {
        $set: { status: 'active', pauseReason: null, startedAt: campaign.startedAt || new Date(), updatedAt: new Date(), startSource: source }
      });
      const details = await this.getCampaignDetails(campaignId);
      await this.logger.log('info', `Campaign preflight passed: ${campaign.name} — daily ${details.daily.sent}/${details.daily.limit}, campaign ${details.usage.sent}/${details.campaignLimit || 'uncapped'}, failed ${details.usage.failures}`, { campaignId, source });
      const processor = this.processCampaign(campaignId)
        .catch((error) => this.logger.log('error', `Campaign processor stopped: ${error.message}`, { campaignId }))
        .finally(() => {
          if (this.processorPromises.get(campaignId) === processor) this.processorPromises.delete(campaignId);
        });
      this.processorPromises.set(campaignId, processor);
      await this.logger.log('info', `Campaign started: ${campaign.name}`, { campaignId, source });
      await this.emitUpdate(campaignId);
      return { success: true };
    } catch (error) {
      await this.logger.log('error', `Failed to start campaign: ${error.message}`, { campaignId });
      return { success: false, error: error.message };
    }
  }

  async processCampaign(campaignId) {
    if (this.activeCampaigns.has(campaignId)) return;
    const token = { stopped: false };
    this.activeCampaigns.set(campaignId, token);

    try {
      while (!token.stopped) {
        const campaign = await this.campaignDb.findOne({ _id: campaignId });
        if (!campaign || campaign.status !== 'active') break;

        const recipients = await this.recipientDb.find({ campaignId, status: 'queued' }).sort({ order: 1 }).limit(campaign.batchSize);
        if (!recipients.length) {
          await this.campaignDb.update({ _id: campaignId }, {
            $set: { status: 'completed', completedAt: new Date(), updatedAt: new Date(), pauseReason: null }
          });
          await this.logger.log('info', `Campaign completed: ${campaign.name}`, { campaignId });
          await this.emitUpdate(campaignId);
          break;
        }

        for (const recipient of recipients) {
          const currentCampaign = await this.campaignDb.findOne({ _id: campaignId });
          if (!currentCampaign || currentCampaign.status !== 'active' || token.stopped) break;

          const stopProcessing = await this.processRecipient(currentCampaign, recipient);
          await this.emitUpdate(campaignId);
          if (stopProcessing) break;

          const settings = await this.safetyGuard.getSettings();
          const delay = randomBetween(settings.minMessageDelayMs, settings.maxMessageDelayMs);
          if (delay && !(await this.controlledSleep(delay, token))) break;
        }

        const remaining = await this.recipientDb.count({ campaignId, status: 'queued' });
        const afterBatch = await this.campaignDb.findOne({ _id: campaignId });
        if (remaining > 0 && afterBatch?.status === 'active' && campaign.batchDelayMs > 0) {
          await this.controlledSleep(campaign.batchDelayMs, token);
        }
      }
    } finally {
      if (this.activeCampaigns.get(campaignId) === token) this.activeCampaigns.delete(campaignId);
    }
  }

  async processRecipient(campaign, recipient) {
    const phone = normalizePhone(recipient.phone);
    try {
      if (await this.contactManager.isOptedOut(phone)) {
        await this.setRecipientStatus(recipient, 'optedOut', { lastError: 'Suppression list' });
        return false;
      }
      const contact = await this.contactManager.getContact(phone);
      if (!contact || !contact.optIn) {
        await this.setRecipientStatus(recipient, 'skipped', { lastError: 'Contact is not opted in' });
        return false;
      }

      // Check limits before marking this recipient as an attempted send. A safety pause is not a delivery attempt.
      const guardOptions = { campaignLimit: campaign.campaignLimit };
      await this.safetyGuard.canSendMessage(campaign._id, guardOptions);
      await this.setRecipientStatus(recipient, 'sending', { lastError: null });
      const text = this.messageSender.processTemplate(campaign.messageTemplate, { ...contact, phone: `+${phone}` });
      const result = await this.messageSender.sendWithRetry(phone, text, campaign.mediaUrl, campaign._id, guardOptions, async (attempt) => {
        await this.recipientDb.update({ _id: recipient._id }, { $set: { attempts: attempt, lastAttemptAt: new Date(), updatedAt: new Date() } });
      });

      await this.safetyGuard.recordSuccess(campaign._id);
      const pendingAck = result.messageId ? this.pendingAcks.get(result.messageId) : null;
      await this.setRecipientStatus(recipient, 'sent', {
        messageId: result.messageId,
        ack: pendingAck || 'pending',
        ackUpdatedAt: pendingAck ? new Date() : null,
        sentAt: new Date(),
        lastError: null
      });
      if (result.messageId) this.pendingAcks.delete(result.messageId);
      await this.logger.log('info', `Campaign message sent to +${phone}`, { campaignId: campaign._id, messageId: result.messageId });
      return false;
    } catch (error) {
      const uncertain = /SEND_TIMEOUT_UNCERTAIN/.test(error.message || '');
      const shouldPause = /EMERGENCY_PAUSE|DAILY_LIMIT_REACHED|CAMPAIGN_LIMIT_REACHED|FAILURE_RATE_HIGH|WHATSAPP_NOT_CONNECTED|WHATSAPP_STATE_TIMEOUT|SEND_TIMEOUT_UNCERTAIN/.test(error.message || '');
      if (shouldPause) {
        await this.setRecipientStatus(recipient, uncertain ? 'skipped' : 'queued', { lastError: error.message });
        await this.pauseCampaign(campaign._id, error.message);
        return true;
      }
      await this.safetyGuard.recordFailure(campaign._id);
      await this.setRecipientStatus(recipient, 'failed', { lastError: error.message, failedAt: new Date() });
      await this.logger.log('error', `Campaign message failed for +${phone}: ${error.message}`, { campaignId: campaign._id });

      try {
        await this.safetyGuard.canSendMessage(campaign._id, { campaignLimit: campaign.campaignLimit });
      } catch (guardError) {
        if (guardError.message.includes('FAILURE_RATE_HIGH')) {
          await this.pauseCampaign(campaign._id, guardError.message);
          return true;
        }
      }
      return false;
    }
  }

  async setRecipientStatus(recipient, status, fields = {}) {
    await this.recipientDb.update({ _id: recipient._id }, {
      $set: { status, ...fields, updatedAt: new Date() }
    });
  }

  async updateCampaignLimit(campaignId, limit) {
    try {
      const campaign = await this.campaignDb.findOne({ _id: campaignId });
      if (!campaign) throw new Error('Campaign not found.');
      if (campaign.status === 'completed') throw new Error('The limit of a completed campaign cannot be changed.');

      const normalized = this.safetyGuard.normalizeLimit(limit);
      const usage = await this.safetyGuard.getCampaignUsage(campaignId, normalized);
      if (Number.isFinite(normalized) && normalized < usage.sent) {
        throw new Error(`Campaign cap cannot be below the ${usage.sent} messages already sent.`);
      }

      const wasLimitPause = /CAMPAIGN_LIMIT_REACHED/.test(campaign.pauseReason || '');
      await this.campaignDb.update({ _id: campaignId }, {
        $set: {
          campaignLimit: normalized,
          pauseReason: wasLimitPause ? 'Campaign cap changed. Review the value, then press Resume.' : campaign.pauseReason,
          updatedAt: new Date()
        }
      });
      const result = await this.safetyGuard.setCampaignLimit(campaignId, normalized);
      await this.emitUpdate(campaignId);
      return { success: true, campaignLimit: normalized, usage: result.usage };
    } catch (error) {
      await this.logger.log('error', `Campaign cap update failed: ${error.message}`, { campaignId });
      return { success: false, error: error.message };
    }
  }

  async getCampaignDetails(campaignId) {
    const campaign = await this.campaignDb.findOne({ _id: campaignId });
    if (!campaign) return null;
    const [stats, usage, safety] = await Promise.all([
      this.getCampaignStats(campaignId),
      this.safetyGuard.getCampaignUsage(campaignId, campaign.campaignLimit),
      this.safetyGuard.getSettings()
    ]);
    return { ...campaign, stats, usage, daily: { sent: safety.dailyCount, limit: safety.dailyLimit, remaining: safety.dailyRemaining } };
  }

  async pauseCampaign(campaignId, reason = 'Paused by user') {
    const active = this.activeCampaigns.get(campaignId);
    if (active) active.stopped = true;
    await this.campaignDb.update({ _id: campaignId }, {
      $set: { status: 'paused', pauseReason: reason, updatedAt: new Date() }
    });
    const campaign = await this.campaignDb.findOne({ _id: campaignId });
    await this.logger.log('warn', `Campaign paused: ${campaign?.name || campaignId} — ${reason}`, { campaignId, reason });
    await this.emitUpdate(campaignId);
    return { success: true };
  }

  async pauseAll(reason = 'Emergency pause') {
    const active = await this.campaignDb.find({ status: 'active' });
    for (const campaign of active) await this.pauseCampaign(campaign._id, reason);
    return { success: true, paused: active.length };
  }

  async resumeCampaign(campaignId) { return this.startCampaign(campaignId, 'resume'); }

  async recordAck(messageId, ack) {
    const label = ACK_LABELS[String(ack)] || `ack_${ack}`;
    const recipient = await this.recipientDb.findOne({ messageId });
    if (!recipient) {
      this.pendingAcks.set(messageId, label);
      return;
    }
    await this.recipientDb.update({ _id: recipient._id }, { $set: { ack: label, ackUpdatedAt: new Date(), updatedAt: new Date() } });
    await this.emitUpdate(recipient.campaignId);
  }

  async getCampaignStats(campaignId) {
    const statuses = ['queued', 'sending', 'sent', 'failed', 'skipped', 'optedOut'];
    const stats = { campaignId, total: 0, queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0, optedOut: 0, delivered: 0, read: 0 };
    for (const status of statuses) stats[status] = await this.recipientDb.count({ campaignId, status });
    stats.total = statuses.reduce((sum, status) => sum + stats[status], 0);
    stats.delivered = await this.recipientDb.count({ campaignId, ack: { $in: ['delivered', 'read', 'played'] } });
    stats.read = await this.recipientDb.count({ campaignId, ack: { $in: ['read', 'played'] } });
    return stats;
  }

  async getDashboardStats() {
    const statuses = ['queued', 'sending', 'sent', 'failed', 'skipped', 'optedOut'];
    const stats = { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0, optedOut: 0, delivered: 0, read: 0 };
    for (const status of statuses) stats[status] = await this.recipientDb.count({ status });
    stats.delivered = await this.recipientDb.count({ ack: { $in: ['delivered', 'read', 'played'] } });
    stats.read = await this.recipientDb.count({ ack: { $in: ['read', 'played'] } });
    return stats;
  }

  async getAllCampaigns() {
    const campaigns = await this.campaignDb.find({}).sort({ createdAt: -1 });
    return Promise.all(campaigns.map(async (campaign) => ({
      ...campaign,
      stats: await this.getCampaignStats(campaign._id),
      usage: await this.safetyGuard.getCampaignUsage(campaign._id, campaign.campaignLimit)
    })));
  }

  async getRecipientReport(campaignId) {
    return this.recipientDb.find({ campaignId }).sort({ order: 1 });
  }

  async destroy() {
    for (const id of [...this.scheduledTasks.keys()]) this.unregisterSchedule(id);
    for (const token of this.activeCampaigns.values()) token.stopped = true;
    await Promise.allSettled([...this.processorPromises.values()]);
  }
}

module.exports = { CampaignManager };
