/* gas/Code.gs のテスト。Google のサービス（スプレッドシート・ロック等）を模擬して動かす。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const code = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8');

function makeEnv(opts = {}) {
  const sheets = {};
  const log = { locks: 0, released: 0 };
  function makeSheet(name) {
    const rows = [];
    return {
      name, rows,
      appendRow(r) { rows.push(r.slice()); },
      setFrozenRows() {},
      getLastRow() { return rows.length; },
      getDataRange() { return { getValues: () => rows.map((r) => r.slice()) }; },
      getRange(r, c, nr, nc) {
        if (nr < 1 || nc < 1) throw new Error('The number of rows in the range must be at least 1.');
        return {
          getValues: () => { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push((rows[r - 1 + i] || [])[c - 1 + j] ?? ''); out.push(row); } return out; },
          setValues: (v) => { for (let i = 0; i < nr; i++) { rows[r - 1 + i] = rows[r - 1 + i] || []; for (let j = 0; j < nc; j++) rows[r - 1 + i][c - 1 + j] = v[i][j]; } },
        };
      },
      deleteRow(n) { rows.splice(n - 1, 1); },
    };
  }
  const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = makeSheet(n)) };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ text: s, setMimeType() { return this; } }) },
    LockService: { getScriptLock: () => ({
      waitLock() { if (opts.lockBusy) throw new Error('timeout'); log.locks++; },
      releaseLock() { log.released++; } }) },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: { formatDate: () => '2026-01-01' },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  vm.runInContext("SECRET_KEY = 'k'", ctx);
  const post = (action, payload, secret = 'k') => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ action, payload, secret }) } }).text);
  const get = (secret = 'k') => JSON.parse(ctx.doGet({ parameter: { secret } }).text);
  return { sheets, post, get, log };
}

module.exports = function (t) {
  t('GAS: add to a brand-new empty sheet works', () => {
    const e = makeEnv();
    assert.strictEqual(e.post('addEntry', { id: 'a1', date: '2026-09-01', person: 'self', type: 'expense', category: '食費', amount: 100 }).status, 'ok');
    assert.strictEqual(e.get().entries.length, 1);
  });
  t('GAS: adding the same id twice keeps one row (idempotent)', () => {
    const e = makeEnv();
    const entry = { id: 'fx_f1_2026-09', date: '2026-09-01', person: 'self', type: 'expense', category: '住居費', amount: 50000 };
    e.post('addEntry', entry); e.post('addEntry', entry);
    assert.strictEqual(e.get().entries.length, 1);
  });
  t('GAS: update then delete', () => {
    const e = makeEnv();
    e.post('addEntry', { id: 'a1', date: '2026-09-01', amount: 1 });
    e.post('updateEntry', { id: 'a1', date: '2026-09-02', amount: 2 });
    assert.strictEqual(e.get().entries[0].amount, 2);
    e.post('deleteEntry', { id: 'a1' });
    assert.strictEqual(e.get().entries.length, 0);
  });
  t('GAS: delete removes every duplicate row with that id', () => {
    const e = makeEnv();
    e.post('addEntry', { id: 'a1', amount: 1 });
    e.sheets.Entries.appendRow(['a1', '', '', '', '', 1, '', '', '']);
    e.sheets.Entries.appendRow(['b2', '', '', '', '', 1, '', '', '']);
    e.post('deleteEntry', { id: 'a1' });
    assert.deepStrictEqual(e.get().entries.map((x) => x.id), ['b2']);
  });
  t('GAS: deleting a missing or blank id is a no-op', () => {
    const e = makeEnv();
    e.post('addEntry', { id: 'a1', amount: 1 });
    assert.strictEqual(e.post('deleteEntry', { id: 'zzz' }).status, 'ok');
    assert.strictEqual(e.post('deleteEntry', {}).status, 'ok');
    assert.strictEqual(e.get().entries.length, 1);
  });
  t('GAS: setState upserts', () => {
    const e = makeEnv();
    e.post('setState', { key: 'lifeplan', value: '{"a":1}' });
    e.post('setState', { key: 'lifeplan', value: '{"a":2}' });
    assert.strictEqual(e.get().state.lifeplan, '{"a":2}');
    assert.strictEqual(e.sheets.Settings.rows.length, 2);
  });
  t('GAS: every write takes and releases the lock', () => {
    const e = makeEnv();
    e.post('addEntry', { id: 'a', amount: 1 }); e.post('setState', { key: 'k', value: 'v' }); e.post('bogus', {});
    assert.strictEqual(e.log.locks, 3); assert.strictEqual(e.log.released, 3);
  });
  t('GAS: lock unavailable -> busy error, nothing written', () => {
    const e = makeEnv({ lockBusy: true });
    assert.deepStrictEqual(e.post('addEntry', { id: 'a', amount: 1 }), { status: 'error', error: 'busy' });
    assert.strictEqual(e.sheets.Entries, undefined);
  });
  t('GAS: wrong secret is rejected for post and get', () => {
    const e = makeEnv();
    assert.strictEqual(e.post('addEntry', { id: 'a' }, 'nope').error, 'unauthorized');
    assert.strictEqual(e.get('nope').error, 'unauthorized');
    assert.strictEqual(e.post('readAll', {}, 'nope').error, 'unauthorized');
    assert.strictEqual(e.log.locks, 0);
  });
  t('GAS: unknown action returns an error and still releases the lock', () => {
    const e = makeEnv();
    assert.strictEqual(e.post('bogus', {}).status, 'error'); assert.strictEqual(e.log.released, 1);
  });
  t('GAS: readAll over POST returns the same data as GET, without taking the lock', () => {
    const e = makeEnv();
    e.post('addEntry', { id: 'a1', date: '2026-09-01', amount: 5 }); e.post('setState', { key: 'people', value: '{}' });
    const locksBefore = e.log.locks;
    const r = e.post('readAll', {});
    assert.strictEqual(r.status, 'ok');
    assert.deepStrictEqual(r.entries, e.get().entries);
    assert.deepStrictEqual(r.state, e.get().state);
    assert.strictEqual(e.log.locks, locksBefore);
  });
};
