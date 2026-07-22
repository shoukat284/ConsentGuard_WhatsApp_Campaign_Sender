const path = require('path');
const fs = require('fs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const Handlebars = require('handlebars');
const { normalizePhone, normalizeWhatsAppId, sleep, withTimeout } = require('./utils');

class MessageSender {
  constructor(logger, safetyGuard, dataDir) {
    this.logger = logger;
    this.safetyGuard = safetyGuard;
    this.dataDir = dataDir;
    this.client = null;
    this.status = 'disconnected';
    this.initializing = false;
    this.callbacks = {
      qr: null,
      status: null,
      optOut: null,
      reOptIn: null,
      ack: null
    };
  }

  setStatus(status, details = null) {
    this.status = status;
    if (this.callbacks.status) this.callbacks.status({ status, details });
  }


  resolveBrowserExecutable() {
    const candidates = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      process.platform === 'win32' && path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
      process.platform === 'win32' && path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe'),
      process.platform === 'win32' && path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
      process.platform === 'win32' && path.join(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge.exe'),
      process.platform === 'win32' && path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
      process.platform === 'darwin' && '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      process.platform === 'linux' && '/usr/bin/google-chrome',
      process.platform === 'linux' && '/usr/bin/chromium',
      process.platform === 'linux' && '/usr/bin/chromium-browser'
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate));
  }

  buildClient() {
    const executablePath = this.resolveBrowserExecutable();
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: 'marketing-desktop',
        dataPath: path.join(this.dataDir, 'whatsapp-auth')
      }),
      authTimeoutMs: 120000,
      qrMaxRetries: 8,
      puppeteer: {
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      }
    });

    client.on('loading_screen', (percent, message) => {
      this.setStatus('loading', `${percent}% ${message || ''}`.trim());
    });
    client.on('qr', (qr) => {
      this.setStatus('qr_required');
      if (this.callbacks.qr) this.callbacks.qr(qr);
    });
    client.on('authenticated', () => this.setStatus('authenticated'));
    client.on('auth_failure', async (message) => {
      this.initializing = false;
      this.setStatus('auth_failure', message);
      await this.logger.log('error', `WhatsApp authentication failed: ${message}`);
    });
    client.on('ready', async () => {
      this.initializing = false;
      this.setStatus('connected');
      await this.logger.log('info', 'WhatsApp connected and ready');
    });
    client.on('disconnected', async (reason) => {
      this.initializing = false;
      if (this.client === client) this.client = null;
      this.setStatus('disconnected', String(reason || 'Disconnected'));
      await this.logger.log('warn', `WhatsApp disconnected: ${reason || 'unknown reason'}`);
      try { await client.destroy(); } catch (_) { /* already closed */ }
    });
    client.on('message', (message) => this.handleIncomingMessage(message).catch((error) => {
      this.logger.log('error', `Incoming reply processing failed: ${error.message}`);
    }));
    client.on('message_ack', (message, ack) => {
      const messageId = message?.id?._serialized;
      if (messageId && this.callbacks.ack) this.callbacks.ack(messageId, ack);
    });

    return client;
  }

  async connect() {
    if (this.status === 'connected') return { success: true, status: this.status };
    if (this.initializing) return { success: true, status: this.status };

    this.initializing = true;
    this.setStatus('initializing');
    if (!this.client) this.client = this.buildClient();

    const initializingClient = this.client;
    initializingClient.initialize().catch(async (error) => {
      this.initializing = false;
      if (this.client === initializingClient) this.client = null;
      try { await initializingClient.destroy(); } catch (_) { /* initialization did not complete */ }
      this.setStatus('error', error.message);
      await this.logger.log('error', `WhatsApp initialization failed: ${error.message}`);
    });

    return { success: true, status: this.status };
  }

  async disconnect() {
    try {
      if (this.client) await this.client.destroy();
    } catch (error) {
      await this.logger.log('warn', `WhatsApp disconnect warning: ${error.message}`);
    } finally {
      this.client = null;
      this.initializing = false;
      this.setStatus('disconnected');
    }
    return { success: true };
  }

  async logout() {
    try {
      if (this.client) {
        try { await this.client.logout(); } catch (_) { /* session may already be invalid */ }
        try { await this.client.destroy(); } catch (_) { /* ignored */ }
      }
      this.client = null;
      this.initializing = false;
      fs.rmSync(path.join(this.dataDir, 'whatsapp-auth'), { recursive: true, force: true });
      this.setStatus('disconnected');
      await this.logger.log('info', 'WhatsApp session logged out');
      return { success: true };
    } catch (error) {
      await this.logger.log('error', `WhatsApp logout failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async handleIncomingMessage(message) {
    if (!message || !message.body || String(message.from).endsWith('@g.us')) return;
    const text = String(message.body).trim().toUpperCase();
    const phone = normalizePhone(message.from);
    if (!phone) return;

    const optOutKeywords = new Set(['STOP', 'UNSUBSCRIBE', 'UNSUB', 'REMOVE', 'QUIT', 'CANCEL']);
    const optInKeywords = new Set(['START', 'SUBSCRIBE']);

    if (optOutKeywords.has(text)) {
      if (this.callbacks.optOut) await this.callbacks.optOut(phone, text);
      await this.logger.log('info', `Opt-out request received from +${phone}`, { keyword: text });
      await this.client.sendMessage(message.from,
        'You have been unsubscribed from marketing messages. You will not receive further campaigns. Reply START to subscribe again.'
      );
      return;
    }

    if (optInKeywords.has(text)) {
      if (this.callbacks.reOptIn) await this.callbacks.reOptIn(phone, text);
      await this.logger.log('info', `Re-subscription request received from +${phone}`, { keyword: text });
      await this.client.sendMessage(message.from,
        'Your subscription has been restored. Reply STOP at any time to unsubscribe.'
      );
    }
  }


  async verifyConnection() {
    if (this.status !== 'connected' || !this.client) {
      throw new Error('WHATSAPP_NOT_CONNECTED: Connect WhatsApp before starting a campaign');
    }
    let state;
    try {
      state = await withTimeout(
        this.client.getState(),
        15000,
        'WHATSAPP_STATE_TIMEOUT: WhatsApp connection health check timed out'
      );
    } catch (error) {
      if (/WHATSAPP_STATE_TIMEOUT/.test(error.message || '')) throw error;
      throw new Error(`WHATSAPP_NOT_CONNECTED: WhatsApp state check failed: ${error.message}`);
    }
    if (String(state || '').toUpperCase() !== 'CONNECTED') {
      throw new Error(`WHATSAPP_NOT_CONNECTED: WhatsApp session state is ${state || 'unknown'}`);
    }
    return state;
  }

  async resolveChatId(digits) {
    const directId = normalizeWhatsAppId(digits);
    try {
      const registeredId = await withTimeout(
        this.client.getNumberId(digits),
        20000,
        'NUMBER_LOOKUP_TIMEOUT: WhatsApp number lookup timed out'
      );
      if (!registeredId) throw new Error('NOT_REGISTERED: Number is not registered on WhatsApp');
      return registeredId._serialized || directId;
    } catch (error) {
      if (!/NUMBER_LOOKUP_TIMEOUT/.test(error.message || '')) throw error;
      await this.logger.log('warn', `Number lookup timed out for +${digits}; trying direct registration check`, { phone: digits });
      try {
        const registered = await withTimeout(
          this.client.isRegisteredUser(directId),
          15000,
          'NUMBER_LOOKUP_TIMEOUT: Direct WhatsApp registration check timed out'
        );
        if (!registered) throw new Error('NOT_REGISTERED: Number is not registered on WhatsApp');
        return directId;
      } catch (fallbackError) {
        if (/NOT_REGISTERED/.test(fallbackError.message || '')) throw fallbackError;
        throw new Error(`NUMBER_LOOKUP_TIMEOUT: Could not verify +${digits}: ${fallbackError.message}`);
      }
    }
  }

  validateMediaUrl(mediaUrl) {
    if (!mediaUrl) return null;
    try {
      const url = new URL(mediaUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported protocol');
      return url.toString();
    } catch (_) {
      throw new Error('MEDIA_URL_INVALID: Enter a valid HTTP or HTTPS media URL');
    }
  }

  async sendMessage(phone, text, mediaUrl = null, campaignId, guardOptions = {}) {
    await this.verifyConnection();
    const digits = normalizePhone(phone);
    if (!digits) throw new Error('INVALID_PHONE: Phone number is not valid E.164 format');
    await this.safetyGuard.canSendMessage(campaignId, guardOptions);

    const chatId = await this.resolveChatId(digits);
    const safeMediaUrl = this.validateMediaUrl(mediaUrl);
    let sendPromise;
    if (safeMediaUrl) {
      const media = await withTimeout(
        MessageMedia.fromUrl(safeMediaUrl, { unsafeMime: true }),
        60000,
        'MEDIA_DOWNLOAD_TIMEOUT: Media download did not finish within 60 seconds'
      );
      sendPromise = this.client.sendMessage(chatId, media, { caption: text });
    } else {
      sendPromise = this.client.sendMessage(chatId, text);
    }

    let sent;
    try {
      sent = await withTimeout(
        sendPromise,
        45000,
        'SEND_TIMEOUT_UNCERTAIN: WhatsApp did not confirm the send within 45 seconds; the recipient is skipped to avoid a duplicate'
      );
    } catch (error) {
      if (/SEND_TIMEOUT_UNCERTAIN/.test(error.message || '')) {
        await this.logger.log('warn', `Uncertain send state for +${digits}; campaign will pause to avoid a duplicate`, { phone: digits, campaignId });
      }
      throw error;
    }

    return {
      success: true,
      messageId: sent?.id?._serialized || null,
      chatId
    };
  }

  isPermanentError(error) {
    return /INVALID_PHONE|NOT_REGISTERED|MEDIA_URL_INVALID|MEDIA_DOWNLOAD_TIMEOUT|CAMPAIGN_LIMIT_REACHED|DAILY_LIMIT_REACHED|EMERGENCY_PAUSE|FAILURE_RATE_HIGH|WHATSAPP_NOT_CONNECTED|WHATSAPP_STATE_TIMEOUT|NUMBER_LOOKUP_TIMEOUT|SEND_TIMEOUT_UNCERTAIN/.test(error.message || '');
  }

  async sendWithRetry(phone, text, mediaUrl, campaignId, guardOptions = {}, onAttempt = null) {
    // Backward-compatible support for the previous five-argument signature.
    if (typeof guardOptions === 'function') {
      onAttempt = guardOptions;
      guardOptions = {};
    }
    const settings = await this.safetyGuard.getSettings();
    const maxAttempts = 1 + settings.maxRetries;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        if (onAttempt) await onAttempt(attempt);
        return await this.sendMessage(phone, text, mediaUrl, campaignId, guardOptions);
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts || this.isPermanentError(error)) break;
        const delay = settings.retryDelayMs * (2 ** (attempt - 1));
        await this.logger.log('warn', `Message retry scheduled for +${normalizePhone(phone)} (attempt ${attempt + 1}/${maxAttempts})`, {
          delayMs: delay,
          error: error.message
        });
        await sleep(delay);
      }
    }
    throw lastError;
  }

  processTemplate(template, contact) {
    const compiled = Handlebars.compile(String(template || ''), { noEscape: true, strict: false });
    return compiled(contact || {});
  }

  onQRCode(callback) { this.callbacks.qr = callback; }
  onStatusChange(callback) { this.callbacks.status = callback; }
  onOptOut(callback) { this.callbacks.optOut = callback; }
  onReOptIn(callback) { this.callbacks.reOptIn = callback; }
  onAck(callback) { this.callbacks.ack = callback; }
  getStatus() { return { status: this.status, connected: this.status === 'connected' && Boolean(this.client) }; }
  async destroy() { return this.disconnect(); }
}

module.exports = { MessageSender };
