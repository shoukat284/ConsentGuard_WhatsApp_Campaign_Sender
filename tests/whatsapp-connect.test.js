const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MessageSender } = require('../src/modules/messageSender');

function makeLogger() {
  return {
    entries: [],
    async log(level, message, meta = null) {
      this.entries.push({ level, message, meta });
    }
  };
}

function makeClient(initialize, on = () => {}) {
  return {
    initialize,
    destroy: async () => {},
    on
  };
}

test('connect button calls share one startup attempt while WhatsApp is initializing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consentguard-connect-'));
  const sender = new MessageSender(makeLogger(), {}, dir);
  let builds = 0;
  let initializes = 0;
  let releaseInitialize;

  sender.buildClient = () => {
    builds += 1;
    return makeClient(async () => {
      initializes += 1;
      await new Promise((resolve) => { releaseInitialize = resolve; });
    });
  };

  const first = await sender.connect();
  const activePromise = sender.connectPromise;
  const second = await sender.connect();
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(builds, 1);
  assert.equal(initializes, 1);

  releaseInitialize();
  await activePromise;
});

test('locked WhatsApp browser profile is cleaned and retried once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consentguard-lock-'));
  const logger = makeLogger();
  const sender = new MessageSender(logger, {}, dir);
  let builds = 0;
  let destroyCalls = 0;
  let stopped = 0;
  let cleaned = 0;

  sender.buildClient = () => {
    builds += 1;
    if (builds === 1) {
      return makeClient(
        async () => { throw new Error('The browser is already running for C:\\Profile. Use a different `userDataDir` or stop the running browser first.'); },
        () => {}
      );
    }
    return makeClient(async () => {});
  };
  sender.stopSessionBrowsers = async () => { stopped += 1; return 1; };
  sender.cleanupProfileLocks = () => { cleaned += 1; return 2; };
  sender.recoverLockedBrowserProfile = async (client) => {
    destroyCalls += client ? 1 : 0;
    if (sender.client === client) sender.client = null;
    await sender.stopSessionBrowsers();
    sender.cleanupProfileLocks();
  };

  assert.equal(sender.isBrowserProfileLockError(new Error('Use a different `userDataDir`')), true);
  await sender.connect();
  await sender.connectPromise;

  assert.equal(builds, 2);
  assert.equal(destroyCalls, 1);
  assert.equal(stopped, 1);
  assert.equal(cleaned, 1);
  assert.ok(logger.entries.some((entry) => /profile is locked/i.test(entry.message)));
});
