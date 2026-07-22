const Datastore = require('nedb-promises');
const path = require('path');
const { sanitizeText } = require('./utils');

class TemplateManager {
  constructor(logger, dataDir) {
    this.logger = logger;
    this.db = Datastore.create({ filename: path.join(dataDir, 'templates.db'), autoload: true });
  }

  async initialize() {
    await this.db.ensureIndex({ fieldName: 'name', unique: true });
  }

  async saveTemplate(data) {
    try {
      const name = sanitizeText(data.name, 200);
      const body = sanitizeText(data.body, 10000);
      if (!name || !body) throw new Error('Template name and message are required.');
      const now = new Date();
      const existing = data._id ? await this.db.findOne({ _id: data._id }) : await this.db.findOne({ name });
      if (existing) {
        await this.db.update({ _id: existing._id }, { $set: { name, body, updatedAt: now } });
        return { success: true, templateId: existing._id };
      }
      const saved = await this.db.insert({ name, body, createdAt: now, updatedAt: now });
      return { success: true, templateId: saved._id };
    } catch (error) {
      await this.logger.log('error', `Template save failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async getTemplates() { return this.db.find({}).sort({ name: 1 }); }

  async deleteTemplate(id) {
    await this.db.remove({ _id: id }, {});
    return { success: true };
  }
}

module.exports = { TemplateManager };
