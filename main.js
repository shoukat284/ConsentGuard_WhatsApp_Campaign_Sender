const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { CampaignManager } = require('./src/modules/campaignManager');
const { ContactManager } = require('./src/modules/contactManager');
const { MessageSender } = require('./src/modules/messageSender');
const { SafetyGuard } = require('./src/modules/safetyGuard');
const { TemplateManager } = require('./src/modules/templateManager');
const { Logger } = require('./src/modules/logger');

let mainWindow;
let campaignManager;
let contactManager;
let messageSender;
let safetyGuard;
let templateManager;
let logger;
let cleanupStarted = false;


function migrateLegacyData(dataDir) {
  const legacyDir = path.join(app.getPath('appData'), 'whatsapp-marketing-app');
  if (path.resolve(legacyDir) === path.resolve(dataDir) || !fs.existsSync(legacyDir)) return;
  for (const filename of ['contacts.db', 'optout.db', 'logs.db']) {
    const source = path.join(legacyDir, filename);
    const destination = path.join(dataDir, filename);
    if (fs.existsSync(source) && !fs.existsSync(destination)) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.copyFileSync(source, destination);
    }
  }
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: '#f3f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'src/renderer/index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
}

async function initializeApplication() {
  const dataDir = app.getPath('userData');
  migrateLegacyData(dataDir);
  logger = new Logger(dataDir);
  await logger.initialize();
  contactManager = new ContactManager(logger, dataDir);
  safetyGuard = new SafetyGuard(logger, dataDir);
  templateManager = new TemplateManager(logger, dataDir);
  await Promise.all([contactManager.initialize(), safetyGuard.initialize(), templateManager.initialize()]);

  messageSender = new MessageSender(logger, safetyGuard, dataDir);
  campaignManager = new CampaignManager(contactManager, messageSender, safetyGuard, logger, dataDir);
  await campaignManager.initialize();

  messageSender.onQRCode(async (qr) => {
    try {
      const dataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2, errorCorrectionLevel: 'M' });
      sendToRenderer('qr-code', { dataUrl, generatedAt: new Date().toISOString() });
    } catch (error) {
      await logger.log('error', `QR rendering failed: ${error.message}`);
    }
  });
  messageSender.onStatusChange((payload) => sendToRenderer('whatsapp-status', payload));
  messageSender.onOptOut(async (phone, keyword) => {
    const result = await contactManager.optOutContact(phone, keyword, 'whatsapp_reply');
    sendToRenderer('contact-update', result);
    return result;
  });
  messageSender.onReOptIn(async (phone) => {
    const result = await contactManager.reOptInContact(phone, 'whatsapp_reply');
    sendToRenderer('contact-update', result);
    return result;
  });
  messageSender.onAck((messageId, ack) => campaignManager.recordAck(messageId, ack));
  campaignManager.onUpdate((payload) => sendToRenderer('campaign-update', payload));
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function setupIPCHandlers() {
  ipcMain.handle('select-import-contacts', async (_event, options) => {
    const selected = await dialog.showOpenDialog(mainWindow, {
      title: 'Import opted-in contacts',
      properties: ['openFile'],
      filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    });
    if (selected.canceled || !selected.filePaths[0]) return { success: false, canceled: true };
    return contactManager.importContacts(selected.filePaths[0], options);
  });
  ipcMain.handle('get-contacts', (_event, filters) => contactManager.getAllContacts(filters || {}));
  ipcMain.handle('get-contacts-page', (_event, filters) => contactManager.getContactsPage(filters || {}));
  ipcMain.handle('opt-out-contact', (_event, phone) => contactManager.optOutContact(phone));
  ipcMain.handle('reopt-in-contact', (_event, phone) => contactManager.reOptInContact(phone, 'manual_desktop'));
  ipcMain.handle('bulk-opt-out-contacts', (_event, options) => contactManager.bulkOptOutContacts(options || {}));
  ipcMain.handle('bulk-reopt-in-contacts', (_event, options) => contactManager.bulkReOptInContacts(options || {}));
  ipcMain.handle('delete-contacts', (_event, options) => contactManager.deleteContacts(options || {}));
  ipcMain.handle('get-opt-out-list', () => contactManager.getOptOutList());

  ipcMain.handle('create-campaign', (_event, data) => campaignManager.createCampaign(data));
  ipcMain.handle('start-campaign', (_event, id) => campaignManager.startCampaign(id));
  ipcMain.handle('pause-campaign', (_event, id) => campaignManager.pauseCampaign(id));
  ipcMain.handle('resume-campaign', (_event, id) => campaignManager.resumeCampaign(id));
  ipcMain.handle('get-campaigns', () => campaignManager.getAllCampaigns());
  ipcMain.handle('get-campaign-stats', (_event, id) => campaignManager.getCampaignStats(id));
  ipcMain.handle('get-campaign-details', (_event, id) => campaignManager.getCampaignDetails(id));
  ipcMain.handle('get-dashboard-stats', () => campaignManager.getDashboardStats());
  ipcMain.handle('get-recipient-report', (_event, id) => campaignManager.getRecipientReport(id));
  ipcMain.handle('export-campaign-report', async (_event, id) => {
    const rows = await campaignManager.getRecipientReport(id);
    const save = await dialog.showSaveDialog(mainWindow, {
      title: 'Export campaign report',
      defaultPath: `campaign-report-${id}.csv`,
      filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    });
    if (save.canceled || !save.filePath) return { success: false, canceled: true };
    const headers = ['phone', 'status', 'attempts', 'messageId', 'ack', 'lastError', 'sentAt', 'failedAt'];
    const content = [headers.map(csvEscape).join(','), ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(','))].join('\n');
    fs.writeFileSync(save.filePath, content, 'utf8');
    return { success: true, filePath: save.filePath };
  });

  ipcMain.handle('get-safety-settings', () => safetyGuard.getSettings());
  ipcMain.handle('update-safety-settings', (_event, settings) => safetyGuard.updateSettings(settings));
  ipcMain.handle('set-campaign-limit', (_event, id, limit) => campaignManager.updateCampaignLimit(id, limit));
  ipcMain.handle('emergency-pause', async () => {
    await safetyGuard.emergencyPause();
    await campaignManager.pauseAll('Emergency pause');
    return { success: true };
  });
  ipcMain.handle('resume-sending', () => safetyGuard.resume());

  ipcMain.handle('save-template', (_event, data) => templateManager.saveTemplate(data));
  ipcMain.handle('get-templates', () => templateManager.getTemplates());
  ipcMain.handle('delete-template', (_event, id) => templateManager.deleteTemplate(id));

  ipcMain.handle('get-logs', (_event, filters) => logger.getLogs(filters || {}));
  ipcMain.handle('connect-whatsapp', () => messageSender.connect());
  ipcMain.handle('disconnect-whatsapp', () => messageSender.disconnect());
  ipcMain.handle('logout-whatsapp', () => messageSender.logout());
  ipcMain.handle('get-whatsapp-status', () => messageSender.getStatus());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    await initializeApplication();
    setupIPCHandlers();
    createWindow();
  }).catch((error) => {
    console.error(error);
    dialog.showErrorBox('Startup failed', error.message);
    app.quit();
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (cleanupStarted) return;
  event.preventDefault();
  cleanupStarted = true;
  Promise.resolve()
    .then(() => campaignManager?.destroy())
    .then(() => messageSender?.destroy())
    .catch((error) => console.error(error))
    .finally(() => app.quit());
});

process.on('uncaughtException', (error) => logger?.log('error', `Uncaught exception: ${error.stack || error.message}`));
process.on('unhandledRejection', (error) => logger?.log('error', `Unhandled rejection: ${error?.stack || error}`));
