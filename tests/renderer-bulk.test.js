const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('contacts bulk-action stability script is loaded after app.js', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const appIndex = html.indexOf('<script src="app.js"></script>');
  const fixIndex = html.indexOf('<script src="contactBulkActionsFix.js"></script>');

  assert.notEqual(appIndex, -1);
  assert.notEqual(fixIndex, -1);
  assert.ok(fixIndex > appIndex, 'bulk-action fix must load after app.js so it can access existing contact state helpers');
});

test('contacts bulk-action stability script blocks the old handler and always resets controls', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'contactBulkActionsFix.js'), 'utf8');

  assert.match(source, /stopImmediatePropagation\(\)/, 'capture handler must prevent the original click handler from also running');
  assert.match(source, /resetBulkControls\(\{ clearSelection: true \}\)/, 'successful bulk actions must clear stale selected contact state');
  assert.match(source, /finally\s*\{[\s\S]*resetBulkControls\(\{ clearSelection: false \}\)/, 'dropdown and Apply button must be re-enabled in a finally block');
  assert.match(source, /setTimeout\(\(\) => resetBulkControls\(\{ clearSelection: true \}\), 0\)/, 'dropdown must be reset again after the contact table repaint');
});
