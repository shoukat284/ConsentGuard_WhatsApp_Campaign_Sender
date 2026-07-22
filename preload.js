const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('electronAPI', {
  selectImportContacts: (options) => ipcRenderer.invoke('select-import-contacts', options),
  getContacts: (filters) => ipcRenderer.invoke('get-contacts', filters),
  getContactsPage: (filters) => ipcRenderer.invoke('get-contacts-page', filters),
  optOutContact: (phone) => ipcRenderer.invoke('opt-out-contact', phone),
  reOptInContact: (phone) => ipcRenderer.invoke('reopt-in-contact', phone),
  bulkOptOutContacts: (options) => ipcRenderer.invoke('bulk-opt-out-contacts', options),
  bulkReOptInContacts: (options) => ipcRenderer.invoke('bulk-reopt-in-contacts', options),
  deleteContacts: (options) => ipcRenderer.invoke('delete-contacts', options),
  getOptOutList: () => ipcRenderer.invoke('get-opt-out-list'),

  createCampaign: (data) => ipcRenderer.invoke('create-campaign', data),
  startCampaign: (id) => ipcRenderer.invoke('start-campaign', id),
  pauseCampaign: (id) => ipcRenderer.invoke('pause-campaign', id),
  resumeCampaign: (id) => ipcRenderer.invoke('resume-campaign', id),
  getCampaigns: () => ipcRenderer.invoke('get-campaigns'),
  getCampaignStats: (id) => ipcRenderer.invoke('get-campaign-stats', id),
  getCampaignDetails: (id) => ipcRenderer.invoke('get-campaign-details', id),
  getDashboardStats: () => ipcRenderer.invoke('get-dashboard-stats'),
  getRecipientReport: (id) => ipcRenderer.invoke('get-recipient-report', id),
  exportCampaignReport: (id) => ipcRenderer.invoke('export-campaign-report', id),

  getSafetySettings: () => ipcRenderer.invoke('get-safety-settings'),
  updateSafetySettings: (settings) => ipcRenderer.invoke('update-safety-settings', settings),
  setCampaignLimit: (id, limit) => ipcRenderer.invoke('set-campaign-limit', id, limit),
  emergencyPause: () => ipcRenderer.invoke('emergency-pause'),
  resumeSending: () => ipcRenderer.invoke('resume-sending'),

  saveTemplate: (data) => ipcRenderer.invoke('save-template', data),
  getTemplates: () => ipcRenderer.invoke('get-templates'),
  deleteTemplate: (id) => ipcRenderer.invoke('delete-template', id),

  getLogs: (filters) => ipcRenderer.invoke('get-logs', filters),
  connectWhatsApp: () => ipcRenderer.invoke('connect-whatsapp'),
  disconnectWhatsApp: () => ipcRenderer.invoke('disconnect-whatsapp'),
  logoutWhatsApp: () => ipcRenderer.invoke('logout-whatsapp'),
  getWhatsAppStatus: () => ipcRenderer.invoke('get-whatsapp-status'),

  onQRCode: (callback) => on('qr-code', callback),
  onWhatsAppStatus: (callback) => on('whatsapp-status', callback),
  onCampaignUpdate: (callback) => on('campaign-update', callback),
  onContactUpdate: (callback) => on('contact-update', callback)
});
