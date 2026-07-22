const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const Handlebars = require('handlebars');
const { normalizePhone, normalizeWhatsAppId, sleep, withTimeout } = require('./utils');

const execFileAsync = promisify(execFile);

class MessageSender {
  constructor(logger, safetyGuard, dataDir) {
    this.logger = logger;
    this.safetyGuard = safetyGuard;
    this.dataDir = dataDir;
    this.client = null;
    this.status = 'disconnected';
    this.initializing = false;
    this.connectPromise = null;
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

  authDataPath() {
    return path.join(this.dataDir, 'whatsapp-auth');
  }

  sessionPath() {
    return path.join(this.authDataPath(), 'session-marketing-desktop');
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
        dataPath: this.authDataPath()
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

    const isCurrentClient = () => this.client === client;

    client.on('loading_screen', (percent, message) => {
      if (!isCurrentClient()) return;
      this.setStatus('loading', `${percent}% ${message || ''}`.trim());
    });
    client.on('qr', (qr) => {
      if (!isCurrentClient()) return;
      this.setStatus('qr_required');
      if (this.callbacks.qr) this.callbacks.qr(qr);
    });
    client.on('authenticated', () => {
      if (!isCurrentClient()) return;
      this.setStatus('authenticated');
    });
    client.on('auth_failure', async (message) => {
      if (!isCurrentClient()) return;
      this.initializing = false;
      this.setStatus('auth_failure', message);
      await this.logger.log('error', `WhatsApp authentication failed: ${message}`);
    });
    client.on('ready', async () => {
      if (!isCurrentClient()) return;
      this.initializing = false;
      this.setStatus('connected');
      await this.logger.log('info', 'WhatsApp connected and ready');
    });
    client.on('disconnected', async (reason) => {
      if (!isCurrentClient()) return;
      this.initializing = false;
      this.connectPromise = null;
      this.client = null;
      this.setStatus('disconnected', String(reason || 'Disconnected'));
      await this.logger.log('warn', `WhatsApp disconnected: ${reason || 'unknown reason'}`);
      try { await client.destroy(); } catch (_) { /* already closed */ }
    });
    client.on('message', (message) => {
      if (!isCurrentClient()) return;
      this.handleIncomingMessage(message).catch((error) => {
        this.logger.log('error', `Incoming reply processing failed: ${error.message}`);
      });
    });
    client.on('message_ack', (message, ack) => {
      if (!isCurrentClient()) return;
      const messageId = message?.id?._serialized;
      if (messageId && this.callbacks.ack) this.callbacks.ack(messageId, ack);
    });

    return client;
  }

  isBrowserProfileLockError(error) {
    return /browser is already running|userDataDir|SingletonLock|ProcessSingleton|profile.*in use/i.test(error?.message || '');
  }

  cleanupProfileLocks() {
    const sessionDir = this.sessionPath();
    const lockNames = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile', 'LOCK'];
    let removed = 0;
    for (const name of lockNames) {
      const lockPath = path.join(sessionDir, name);
      try {
        if (fs.existsSync(lockPath)) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          removed += 1;
        }
      } catch (_) {
        // Active Chromium may still hold the lock. The next initialize attempt will report a clear error if so.
      }
    }
    return removed;
  }

  async stopSessionBrowsers() {
    const sessionDir = this.sessionPath();
    if (!fs.existsSync(sessionDir)) return 0;

    try {
      if (process.platform === 'win32') {
        const safeSession = sessionDir.replace(/'/g, "''");
        const script = `
$session = '${safeSession}'
$processes = @(Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and
  $_.CommandLine.IndexOf($session, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
  $_.Name -match '^(chrome|msedge|chromium|brave|opera)\\.exe$'
})
foreach ($item in $processes) {
  try {
    Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop
    Write-Output $item.ProcessId
  } catch { }
}
`;
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const { stdout } = await execFileAsync(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
          { windowsHide: true, timeout: 10000 }
        );
        return stdout.split(/\r?\n/).filter((line) => /^\d+$/.test(line.trim())).length;
      }

      const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,comm=,args='], { timeout: 10000 });
      const matches = stdout.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && line.includes(sessionDir) && /chrome|chromium|msedge|brave|opera/i.test(line));
      let killed = 0;
      for (const line of matches) {
        const pid = Number(line.split(/\s+/)[0]);
        if (pid && pid !== process.pid) {
          try {
            process.kill(pid, 'SIGKILL');
            killed += 1;
          } catch (_) {
            // The process may already be gone.
          }
        }
      }
      return killed;
    } catch (error) {
      await this.logger.log('warn', `Could not automatically stop stale WhatsApp browser process: ${error.message}`);
      return 0;
    }
  }

  async recoverLockedBrowserProfile(lockedClient) {
    this.setStatus('recovering', 'Closing stale WhatsApp browser session and retrying…');
    try {
      if (lockedClient) {
        await withTimeout(lockedClient.destroy(), 10000, 'Browser cleanup timed out');
      }
    } catch (_) {
      // Continue with targeted stale-process cleanup below.
    }

    if (this.client === lockedClient) this.client = null;
    const killed = await this.stopSessionBrowsers();
    await sleep(800);
    const removedLocks = this.cleanupProfileLocks();
    await sleep(500);
    await this.logger.log(
      'warn',
      `Recovered locked WhatsApp browser profile; stopped ${killed} stale process(es), removed ${removedLocks} lock file(s)`
    );
  }

  async initializeClientWithRecovery() {
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (!this.client) this.client = this.buildClient();
      const initializingClient = this.client;
      try {
        await initializingClient.initialize();
        return;
      } catch (error) {
        lastError = error;
        if (!this.isBrowserProfileLockError(error) || attempt >= 2) throw error;
        await this.logger.log('warn', `WhatsApp browser profile is locked: ${error.message}`);
        await this.recoverLockedBrowserProfile(initializingClient);
        this.initializing = true;
        this.setStatus('initializing', 'Retrying WhatsApp startup after stale browser cleanup…');
      }
    }
    throw lastError;
  }

  async connect() {
    if (this.status === 'connected') return { success: true, status: this.status };
    if (this.connectPromise || this.initializing) return { success: true, status: this.status, message: 'WhatsApp connection is already starting.' };

    this.initializing = true;
    this.setStatus('initializing');

    const connectPromise = this.initializeClientWithRecovery();
    this.connectPromise = connectPromise;

    connectPromise.catch(async (error) => {
      this.initializing = false;
      const failedClient = this.client;
      this.client = null;
      try { await failedClient?.destroy(); } catch (_) { /* initialization did not complete */ }
      this.setStatus('error', error.message);
      await this.logger.log('error', `WhatsApp initialization failed: ${error.message}`);
    }).finally(() => {
      if (this.connectPromise === connectPromise) this.connectPromise = null;
    });

    return { success: true, status: this.status };
  }

  async disconnect() {
    const activeClient = this.client;
    try {
      this.initializing = false;
      this.connectPromise = null;
      this.client = null;
      if (activeClient) await withTimeout(activeClient.destroy(), 15000, 'Disconnect timed out while closing WhatsApp browser');
    } catch (error) {
      await this.logger.log('warn', `WhatsApp disconnect warning: ${error.message}`);
    } finally {
      this.setStatus('disconnected');
    }
    return { success: true };
  }

  async logout() {
    try {
      const activeClient = this.client;
      this.client = null;
      this.initializing = false;
      this.connectPromise = null;
      if (activeClient) {
        try { await activeClient.logout(); } catch (_) { /* session may already be invalid */ }
        try { await withTimeout(activeClient.destroy(), 15000, 'Logout browser cleanup timed out'); } catch (_) { /* ignored */ }
      }
      await this.stopSessionBrowsers();
      fs.rmSync(this.authDataPath(), { recursive: true, force: true });
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
  getStatus() {
    return {
      status: this.status,
      connected: this.status === 'connected' && Boolean(this.client),
      initializing: Boolean(this.initializing || this.connectPromise)
    };
  }
  async destroy() { return this.disconnect(); }
}

module.exports = { MessageSender };
