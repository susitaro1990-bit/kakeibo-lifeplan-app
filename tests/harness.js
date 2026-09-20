/* テスト用の読み込み補助（Node.js 標準機能のみ・追加インストール不要）。
   index.html のスクリプトを、画面（DOM）を持たない疑似環境で実行し、
   計算・同期・検証などの関数を直接呼び出せるようにする。日付は固定する。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FIXED_NOW = new Date(2026, 8, 21, 12, 0, 0); // 2026-09-21

function loadApp(opts = {}) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

  // どんな呼び出しも受け流す「何もしない要素」
  const dummy = () => new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'length' ? 0 : k === 'then' ? undefined : dummy()),
    apply: () => dummy(),
    set: () => true,
    construct: () => dummy(),
  });

  const store = new Map(Object.entries(opts.localStorage || {}));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };

  class FixedDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(FIXED_NOW.getTime()); }
    static now() { return FIXED_NOW.getTime(); }
  }

  const fetchLog = [];
  const ctx = {
    console: { log() {}, error() {}, warn() {} },
    Date: FixedDate,
    localStorage,
    document: {
      getElementById: () => dummy(), querySelector: () => dummy(), querySelectorAll: () => [],
      createElement: () => dummy(), documentElement: dummy(), body: dummy(), addEventListener() {}, hidden: false,
    },
    window: { addEventListener() {} },
    navigator: {},
    location: { protocol: 'http:', hostname: 'test' },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: (f) => 0,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout() {},
    structuredClone,
    confirm: () => true,
    fetch: async (url, o) => { fetchLog.push({ url, o }); throw new TypeError('offline (test)'); },
  };
  ctx.window.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return {
    ctx,
    fetchLog,
    // 疑似環境の中で作られたオブジェクトは、比較の際に別物として扱われてしまうため、
    // 普通のオブジェクトに変換して返す（Promise と数値・文字列はそのまま）。
    run: (code) => {
      const v = vm.runInContext(code, ctx);
      if (v && typeof v.then === 'function') return v;
      return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
    },
    store,
  };
}

module.exports = { loadApp };
