const Datastore = require('nedb-promises');
const path = require('path');

class Logger {
  constructor(dataDir) {
    this.db = Datastore.create({ filename: path.join(dataDir, 'logs.db'), autoload: true });
  }

  async initialize() {
    await this.db.ensureIndex({ fieldName: 'timestamp' });
  }

  async log(level, message, metadata = {}) {
    const logEntry = {
      level: ['info', 'warn', 'error'].includes(level) ? level : 'info',
      message: String(message),
      metadata,
      timestamp: new Date()
    };
    await this.db.insert(logEntry);
    console.log(`[${logEntry.timestamp.toISOString()}] [${logEntry.level.toUpperCase()}] ${logEntry.message}`);
    return logEntry;
  }

  async getLogs(filters = {}) {
    const query = {};
    if (filters.level) query.level = filters.level;
    if (filters.startDate || filters.endDate) {
      query.timestamp = {};
      if (filters.startDate) query.timestamp.$gte = new Date(filters.startDate);
      if (filters.endDate) query.timestamp.$lte = new Date(filters.endDate);
    }
    const limit = Math.min(1000, Math.max(1, Number(filters.limit) || 100));
    return this.db.find(query).sort({ timestamp: -1 }).limit(limit);
  }
}

module.exports = { Logger };
