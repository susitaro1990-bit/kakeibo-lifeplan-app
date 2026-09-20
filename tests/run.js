/* テストの実行: node tests/run.js
   （追加のインストールは不要。ライフプランの計算式をわざと変えたときだけ、
    UPDATE_GOLDEN=1 node tests/run.js で基準データを作り直す） */
let passed = 0;
const failures = [];
const queue = [];
const t = (name, fn) => queue.push({ name, fn });

require('./gas.test')(t);
require('./app.test')(t);

(async () => {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed++;
      console.log('ok   -', name);
    } catch (e) {
      failures.push(name);
      console.log('FAIL -', name, '\n      ', (e && e.message || e).toString().split('\n').join('\n       '));
    }
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
