const Datastore = require('nedb-promises');
const { parse } = require('csv-parse');
const fs = require('fs');
const path = require('path');
const {
  normalizePhone,
  displayPhone,
  parseTags,
  truthyCsv,
  sanitizeText
} = require('./utils');

class ContactManager {
  constructor(logger, dataDir) {
    this.logger = logger;
    this.dataDir = dataDir;
    this.db = Datastore.create({
      filename: path.join(dataDir, 'contacts.db'),
      autoload: true
    });
    this.optOutDb = Datastore.create({
      filename: path.join(dataDir, 'optout.db'),
      autoload: true
    });
  }

  async initialize() {
    // Normalize and deduplicate legacy records before enforcing unique indexes.
    await this.migrateLegacyPhones();
    await this.db.ensureIndex({ fieldName: 'phone', unique: true });
    await this.optOutDb.ensureIndex({ fieldName: 'phone', unique: true });
  }

  async migrateLegacyPhones() {
    const contacts = await this.db.find({});
    const seen = new Set();

    for (const contact of contacts) {
      const normalized = normalizePhone(contact.phone);
      if (!normalized) {
        await this.db.remove({ _id: contact._id }, {});
        continue;
      }
      if (seen.has(normalized)) {
        await this.db.remove({ _id: contact._id }, {});
        continue;
      }
      seen.add(normalized);
      if (normalized !== contact.phone) {
        await this.db.update({ _id: contact._id }, { $set: { phone: normalized, updatedAt: new Date() } });
      }
    }

    const suppressions = await this.optOutDb.find({});
    const suppressionSeen = new Set();
    for (const record of suppressions) {
      const normalized = normalizePhone(record.phone);
      if (!normalized || suppressionSeen.has(normalized)) {
        await this.optOutDb.remove({ _id: record._id }, {});
        continue;
      }
      suppressionSeen.add(normalized);
      if (normalized !== record.phone) {
        await this.optOutDb.update({ _id: record._id }, { $set: { phone: normalized } });
      }
    }
  }

  async importContacts(filePath, options = {}) {
    try {
      if (!filePath || !fs.existsSync(filePath)) throw new Error('CSV file was not found.');
      if (!options.consentConfirmed) {
        throw new Error('Import cancelled: confirm that every imported contact has given permission to receive messages.');
      }

      const consentSource = sanitizeText(options.consentSource, 200);
      if (!consentSource) throw new Error('A consent source is required, for example website form or signed customer list.');

      const defaultCountryCode = String(options.defaultCountryCode || '').replace(/\D/g, '');
      const rows = await this.parseCSV(filePath);
      let imported = 0;
      let updated = 0;
      let skipped = 0;
      const errors = [];

      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const rawPhone = row.phone || row.mobile || row.number || row.whatsapp;
        const phone = normalizePhone(rawPhone, defaultCountryCode);
        if (!phone) {
          skipped += 1;
          errors.push(`Row ${index + 2}: invalid phone number`);
          continue;
        }

        // An explicit negative value in the row is respected even when the import is globally confirmed.
        const rowOptInValue = row.opt_in ?? row.optin ?? row.consent;
        if (rowOptInValue !== undefined && String(rowOptInValue).trim() && !truthyCsv(rowOptInValue)) {
          skipped += 1;
          errors.push(`Row ${index + 2}: contact is not marked opted-in`);
          continue;
        }

        if (await this.isOptedOut(phone)) {
          skipped += 1;
          errors.push(`Row ${index + 2}: number is permanently suppressed`);
          continue;
        }

        const now = new Date();
        const contactData = {
          phone,
          name: sanitizeText(row.name, 200),
          email: sanitizeText(row.email, 320),
          tags: parseTags(row.tags),
          optIn: true,
          optInDate: row.opt_in_date ? new Date(row.opt_in_date) : now,
          consentSource: sanitizeText(row.consent_source || consentSource, 200),
          consentEvidence: sanitizeText(row.consent_evidence || options.consentEvidence, 1000),
          source: 'csv_import',
          updatedAt: now
        };

        const existing = await this.db.findOne({ phone });
        if (existing) {
          await this.db.update(
            { phone },
            {
              $set: {
                ...contactData,
                tags: parseTags([...(existing.tags || []), ...contactData.tags])
              }
            }
          );
          updated += 1;
        } else {
          await this.db.insert({ ...contactData, createdAt: now });
          imported += 1;
        }
      }

      await this.logger.log('info', `Contact import completed: ${imported} new, ${updated} updated, ${skipped} skipped`, {
        file: path.basename(filePath),
        consentSource
      });
      return { success: true, imported, updated, skipped, errors: errors.slice(0, 50) };
    } catch (error) {
      await this.logger.log('error', `Contact import failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async optOutContact(phoneNumber, reason = 'manual_optout', source = 'desktop') {
    try {
      const phone = normalizePhone(phoneNumber);
      if (!phone) throw new Error('Invalid phone number.');
      const now = new Date();
      const existing = await this.optOutDb.findOne({ phone });
      const record = {
        phone,
        reason: sanitizeText(reason, 100),
        source: sanitizeText(source, 100),
        optedOutAt: now,
        updatedAt: now
      };
      if (existing) {
        await this.optOutDb.update({ phone }, { $set: record });
      } else {
        await this.optOutDb.insert({ ...record, createdAt: now });
      }

      await this.db.update(
        { phone },
        { $set: { optIn: false, optedOutAt: now, updatedAt: now } },
        { multi: true }
      );

      await this.logger.log('info', `Contact ${displayPhone(phone)} opted out`, { reason, source });
      return { success: true, phone };
    } catch (error) {
      await this.logger.log('error', `Opt-out failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async reOptInContact(phoneNumber, source = 'customer_reply') {
    try {
      const phone = normalizePhone(phoneNumber);
      if (!phone) throw new Error('Invalid phone number.');
      const now = new Date();
      await this.optOutDb.remove({ phone }, { multi: true });

      const existing = await this.db.findOne({ phone });
      if (existing) {
        await this.db.update(
          { phone },
          {
            $set: {
              optIn: true,
              optInDate: now,
              consentSource: sanitizeText(source, 200),
              optedOutAt: null,
              updatedAt: now
            }
          }
        );
      } else {
        await this.db.insert({
          phone,
          name: '',
          email: '',
          tags: [],
          optIn: true,
          optInDate: now,
          consentSource: sanitizeText(source, 200),
          source: 'customer_reply',
          createdAt: now,
          updatedAt: now
        });
      }

      await this.logger.log('info', `Contact ${displayPhone(phone)} opted in again`, { source });
      return { success: true, phone };
    } catch (error) {
      await this.logger.log('error', `Re-opt-in failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async isOptedOut(phoneNumber) {
    const phone = normalizePhone(phoneNumber);
    if (!phone) return true;
    return Boolean(await this.optOutDb.findOne({ phone }));
  }

  async parseCSV(filePath) {
    return new Promise((resolve, reject) => {
      const contacts = [];
      fs.createReadStream(filePath)
        .pipe(parse({
          columns: (headers) => headers.map((header) => String(header).trim().toLowerCase()),
          bom: true,
          skip_empty_lines: true,
          relax_column_count: true,
          trim: true
        }))
        .on('data', (row) => contacts.push(row))
        .on('end', () => resolve(contacts))
        .on('error', reject);
    });
  }


  buildContactQuery(filters = {}) {
    const query = {};
    if (filters.optIn === true || filters.status === 'optedIn') query.optIn = true;
    if (filters.optIn === false || filters.status === 'optedOut') query.optIn = false;
    const search = String(filters.search || '').trim();
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      query.$or = [{ phone: regex }, { name: regex }, { email: regex }, { tags: regex }];
    }
    return query;
  }

  async getContactsPage(filters = {}) {
    const page = Math.max(1, Number(filters.page) || 1);
    const pageSize = Math.min(500, Math.max(10, Number(filters.pageSize) || 100));
    const query = this.buildContactQuery(filters);
    const total = await this.db.count(query);
    const contacts = await this.db.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize);
    return {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      contacts: contacts.map((contact) => ({ ...contact, displayPhone: displayPhone(contact.phone) }))
    };
  }

  async getAllContacts(filters = {}) {
    const query = this.buildContactQuery(filters);
    const contacts = await this.db.find(query).sort({ createdAt: -1 });
    return contacts.map((contact) => ({ ...contact, displayPhone: displayPhone(contact.phone) }));
  }

  async resolveBulkContacts(options = {}) {
    const scope = options.scope === 'allMatching' ? 'allMatching' : 'selected';
    if (scope === 'allMatching') {
      return this.db.find(this.buildContactQuery({ search: options.search, status: options.status })).sort({ createdAt: -1 });
    }

    const wanted = new Set((options.phones || []).map((phone) => normalizePhone(phone)).filter(Boolean));
    if (!wanted.size) return [];
    const contacts = await this.db.find({});
    return contacts.filter((contact) => wanted.has(normalizePhone(contact.phone)));
  }

  async bulkOptOutContacts(options = {}) {
    try {
      const contacts = await this.resolveBulkContacts(options);
      if (!contacts.length) throw new Error('No contacts matched the selected bulk action.');
      let changed = 0;
      for (const contact of contacts) {
        const result = await this.optOutContact(contact.phone, 'bulk_manual_optout', 'desktop_bulk_action');
        if (result.success) changed += 1;
      }
      await this.logger.log('info', `Bulk opt-out completed for ${changed} contact(s)`, { scope: options.scope || 'selected' });
      return { success: true, changed, total: contacts.length };
    } catch (error) {
      await this.logger.log('error', `Bulk opt-out failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async bulkReOptInContacts(options = {}) {
    try {
      const contacts = await this.resolveBulkContacts(options);
      if (!contacts.length) throw new Error('No contacts matched the selected bulk action.');
      let changed = 0;
      for (const contact of contacts) {
        const result = await this.reOptInContact(contact.phone, 'manual_desktop_bulk');
        if (result.success) changed += 1;
      }
      await this.logger.log('info', `Bulk re-subscribe completed for ${changed} contact(s)`, { scope: options.scope || 'selected' });
      return { success: true, changed, total: contacts.length };
    } catch (error) {
      await this.logger.log('error', `Bulk re-subscribe failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async deleteContacts(options = {}) {
    try {
      const contacts = await this.resolveBulkContacts(options);
      if (!contacts.length) throw new Error('No contacts matched the selected bulk action.');
      const phones = new Set(contacts.map((contact) => normalizePhone(contact.phone)).filter(Boolean));
      const all = await this.db.find({});
      let removed = 0;
      for (const contact of all) {
        if (phones.has(normalizePhone(contact.phone))) {
          await this.db.remove({ _id: contact._id }, {});
          removed += 1;
        }
      }
      await this.logger.log('warn', `Deleted ${removed} contact(s) from the local contact list`, { scope: options.scope || 'selected' });
      return { success: true, removed };
    } catch (error) {
      await this.logger.log('error', `Delete contacts failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async getEligibleContacts(selection = {}) {
    let contacts = await this.db.find({ optIn: true });
    const requestedPhones = new Set((selection.phones || []).map((phone) => normalizePhone(phone)).filter(Boolean));
    const requestedTags = new Set(parseTags(selection.tags).map((tag) => tag.toLowerCase()));

    if (requestedPhones.size) {
      contacts = contacts.filter((contact) => requestedPhones.has(normalizePhone(contact.phone)));
    }
    if (requestedTags.size) {
      contacts = contacts.filter((contact) => (contact.tags || []).some((tag) => requestedTags.has(String(tag).toLowerCase())));
    }

    const eligible = [];
    for (const contact of contacts) {
      if (!(await this.isOptedOut(contact.phone))) eligible.push(contact);
    }
    return eligible;
  }

  async getContact(phoneNumber) {
    const phone = normalizePhone(phoneNumber);
    return phone ? this.db.findOne({ phone }) : null;
  }

  async getOptOutList() {
    const records = await this.optOutDb.find({}).sort({ optedOutAt: -1 });
    return records.map((record) => ({ ...record, displayPhone: displayPhone(record.phone) }));
  }
}

module.exports = { ContactManager };
