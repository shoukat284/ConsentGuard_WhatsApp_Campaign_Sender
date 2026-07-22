const Datastore = require('nedb-promises');
const path = require('path');
const { localDateKey } = require('./utils');

const DEFAULTS = {
  dailyLimit: 100,
  maxFailureRate: 0.30,
  minFailureSample: 10,
  minMessageDelayMs: 3000,
  maxMessageDelayMs: 5000,
  maxRetries: 3,
  retryDelayMs: 5000,
  emergencyPaused: false
};

class SafetyGuard {
  constructor(logger, dataDir) {
    this.logger = logger;
    this.settingsDb = Datastore.create({ filename: path.join(dataDir, 'settings.db'), autoload: true });
    this.counterDb = Datastore.create({ filename: path.join(dataDir, 'safety_counters.db'), autoload: true });
    this.settings = { ...DEFAULTS };
  }

  async initialize() {
    await this.settingsDb.ensureIndex({ fieldName: 'key', unique: true });
    await this.counterDb.ensureIndex({ fieldName: 'key', unique: true });
    const stored = await this.settingsDb.findOne({ key: 'safety' });
    if (stored) this.settings = { ...DEFAULTS, ...stored.value };
    else await this.persistSettings();
  }

  async persistSettings() {
    const existing = await this.settingsDb.findOne({ key: 'safety' });
    if (existing) await this.settingsDb.update({ key: 'safety' }, { $set: { value: this.settings, updatedAt: new Date() } });
    else await this.settingsDb.insert({ key: 'safety', value: this.settings, updatedAt: new Date() });
  }

  todayKey(date = new Date()) { return `daily:${localDateKey(date)}`; }
  campaignKey(id) { return `campaign:${id}`; }

  normalizeLimit(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  async getCounter(key) {
    return (await this.counterDb.findOne({ key })) || { key, sent: 0, attempts: 0, failures: 0, limit: null };
  }

  async saveCounter(counter) {
    const existing = await this.counterDb.findOne({ key: counter.key });
    if (existing) await this.counterDb.update({ key: counter.key }, { $set: { ...counter, updatedAt: new Date() } });
    else await this.counterDb.insert({ ...counter, updatedAt: new Date() });
  }

  resolveCampaignLimit(counter, options = {}) {
    if (Object.prototype.hasOwnProperty.call(options, 'campaignLimit')) {
      return this.normalizeLimit(options.campaignLimit);
    }
    return this.normalizeLimit(counter.limit);
  }

  async canSendMessage(campaignId, options = {}) {
    if (this.settings.emergencyPaused) throw new Error('EMERGENCY_PAUSE: Sending is paused');

    const daily = await this.getCounter(this.todayKey());
    if (daily.sent >= this.settings.dailyLimit) {
      throw new Error(`DAILY_LIMIT_REACHED: Daily message limit reached (${daily.sent}/${this.settings.dailyLimit})`);
    }

    const campaign = await this.getCounter(this.campaignKey(campaignId));
    const effectiveLimit = this.resolveCampaignLimit(campaign, options);
    if (Number.isFinite(effectiveLimit) && campaign.sent >= effectiveLimit) {
      throw new Error(`CAMPAIGN_LIMIT_REACHED: Separate campaign cap reached (${campaign.sent}/${effectiveLimit})`);
    }

    if (!options.ignoreFailureRate && campaign.attempts >= this.settings.minFailureSample) {
      const rate = campaign.failures / campaign.attempts;
      if (rate > this.settings.maxFailureRate) {
        throw new Error(`FAILURE_RATE_HIGH: Campaign failure rate ${(rate * 100).toFixed(1)}% is above the configured ${(this.settings.maxFailureRate * 100).toFixed(1)}% threshold`);
      }
    }
    return true;
  }

  async recordSuccess(campaignId) {
    const daily = await this.getCounter(this.todayKey());
    daily.sent += 1;
    await this.saveCounter(daily);

    const campaign = await this.getCounter(this.campaignKey(campaignId));
    campaign.sent += 1;
    campaign.attempts += 1;
    await this.saveCounter(campaign);
  }

  async recordFailure(campaignId) {
    const campaign = await this.getCounter(this.campaignKey(campaignId));
    campaign.attempts += 1;
    campaign.failures += 1;
    await this.saveCounter(campaign);
  }


  async reconcileDailyCount(sent, date = new Date()) {
    const counter = await this.getCounter(this.todayKey(date));
    counter.sent = Math.max(0, Number(sent) || 0);
    counter.attempts = counter.sent;
    counter.failures = 0;
    counter.reconciledAt = new Date();
    await this.saveCounter(counter);
    return counter;
  }

  async reconcileCampaignCounter(campaignId, values = {}) {
    const counter = await this.getCounter(this.campaignKey(campaignId));
    counter.sent = Math.max(0, Number(values.sent) || 0);
    counter.failures = Math.max(0, Number(values.failures) || 0);
    counter.attempts = Math.max(counter.sent + counter.failures, Number(values.attempts) || 0);
    counter.limit = this.normalizeLimit(values.limit);
    counter.reconciledAt = new Date();
    await this.saveCounter(counter);
    return counter;
  }

  async setCampaignLimit(campaignId, limit, options = {}) {
    const counter = await this.getCounter(this.campaignKey(campaignId));
    counter.limit = this.normalizeLimit(limit);
    await this.saveCounter(counter);
    if (!options.silent) {
      const message = counter.limit
        ? `Separate campaign cap updated to ${counter.limit}`
        : 'Separate campaign cap cleared; the global daily limit now applies';
      await this.logger.log('info', message, { campaignId, limit: counter.limit });
    }
    return { success: true, usage: await this.getCampaignUsage(campaignId, counter.limit) };
  }

  async getCampaignUsage(campaignId, explicitLimit) {
    const counter = await this.getCounter(this.campaignKey(campaignId));
    const limit = explicitLimit === undefined ? this.normalizeLimit(counter.limit) : this.normalizeLimit(explicitLimit);
    return {
      sent: counter.sent,
      attempts: counter.attempts,
      failures: counter.failures,
      limit,
      remaining: Number.isFinite(limit) ? Math.max(0, limit - counter.sent) : null
    };
  }

  async updateSettings(patch = {}) {
    const next = { ...this.settings };
    for (const key of Object.keys(DEFAULTS)) {
      if (patch[key] !== undefined) next[key] = patch[key];
    }
    next.dailyLimit = Math.max(1, Number(next.dailyLimit) || DEFAULTS.dailyLimit);
    next.maxFailureRate = Math.min(1, Math.max(0, Number(next.maxFailureRate)));
    next.minFailureSample = Math.max(1, Number(next.minFailureSample) || DEFAULTS.minFailureSample);
    next.minMessageDelayMs = Math.max(0, Number(next.minMessageDelayMs) || 0);
    next.maxMessageDelayMs = Math.max(next.minMessageDelayMs, Number(next.maxMessageDelayMs) || next.minMessageDelayMs);
    next.maxRetries = Math.min(10, Math.max(0, Number(next.maxRetries) || 0));
    next.retryDelayMs = Math.max(500, Number(next.retryDelayMs) || DEFAULTS.retryDelayMs);
    next.emergencyPaused = Boolean(next.emergencyPaused);
    this.settings = next;
    await this.persistSettings();
    await this.logger.log('info', 'Safety settings updated');
    return { success: true, settings: await this.getSettings() };
  }

  async emergencyPause() {
    this.settings.emergencyPaused = true;
    await this.persistSettings();
    await this.logger.log('warn', 'EMERGENCY PAUSE activated');
    return { success: true };
  }

  async resume() {
    this.settings.emergencyPaused = false;
    await this.persistSettings();
    await this.logger.log('info', 'Emergency pause cleared');
    return { success: true };
  }

  async getSettings() {
    const daily = await this.getCounter(this.todayKey());
    return {
      ...this.settings,
      dailyCount: daily.sent,
      dailyRemaining: Math.max(0, this.settings.dailyLimit - daily.sent)
    };
  }
}

module.exports = { SafetyGuard, DEFAULTS };
