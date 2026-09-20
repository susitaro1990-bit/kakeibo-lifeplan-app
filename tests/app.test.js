/* index.html の計算・検証・同期まわりのテスト（画面なしの疑似環境で実行）。
   ライフプランの計算結果は tests/golden-lifeplan.json（63年分）と突き合わせる。
   計算式を意図して変えたときだけ、UPDATE_GOLDEN=1 node tests/run.js で作り直す。 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { loadApp } = require('./harness');

const GOLDEN = path.join(__dirname, 'golden-lifeplan.json');

// 互換性の確認用に、あえて「旧形式（配偶者の年齢・取り崩し枠の項目なし）」のプランを作る
const SCENARIO = `
  lifeplan = defaultLifeplan();
  lifeplan.currentAge = 38; lifeplan.inflationRate = 1.5; lifeplan.initialCash = 3000000; lifeplan.minCashReserve = 1000000;
  lifeplan.baseline.self = { monthlyIncome: 320000, incomeGrowthMode:'rate', incomeGrowthRate: 1.2, incomeGrowthFixed:0, leaves:[] };
  lifeplan.baseline.spouse = { monthlyIncome: 180000, incomeGrowthMode:'fixed', incomeGrowthRate: 0, incomeGrowthFixed: 12000, leaves:[{id:'l1',startYear:2028,years:1,monthlyIncome:60000}] };
  Object.keys(lifeplan.expenses).forEach(k=>{ if(typeof lifeplan.expenses[k]==='number') lifeplan.expenses[k]=0; });
  Object.assign(lifeplan.expenses,{foodMonthly:70000,utilitiesMonthly:22000,clothingMonthly:9000,transportMonthly:15000,hobbyMonthly:12000,socialMonthly:8000,selfAllowance:30000,spouseAllowance:25000,childAllowancePerChild:5000,childLivingCostPerChild:20000,travelAnnual:300000,ceremonyAnnual:100000,childIndependenceAge:22});
  lifeplan.expenses.parentCare={startAge:70,annualCost:800000,years:5}; lifeplan.expenses.remittance={monthlyAmount:20000,startAge:50,endAge:65};
  lifeplan.mortgage={balance:28000000,years:28,rate:1.1}; lifeplan.realEstate={price:35000000,appreciationRate:0.5};
  lifeplan.car={cycleYears:8,cost:2800000}; lifeplan.insurances=[{id:'in1',name:'x',annualPremium:180000}];
  lifeplan.retirement={pensionAnnual:3000000,livingCostAnnual:3600000,retireAge:65}; lifeplan.retirementBonus={amount:15000000,age:65};
  lifeplan.investments=[{id:'a',type:'nisa_tsumitate',name:'t',monthlyAmount:33000,returnRate:3,startingBalance:1500000},{id:'b',type:'nisa_growth',name:'g',monthlyAmount:20000,returnRate:4,startingBalance:500000},{id:'c',type:'ideco',name:'i',monthlyAmount:23000,returnRate:3,startingBalance:0},{id:'d',type:'taxable',name:'z',monthlyAmount:10000,returnRate:2,startingBalance:800000},{id:'e',type:'child_nisa',name:'c',monthlyAmount:5000,returnRate:2,startingBalance:0}];
  lifeplan.otherEvents=[{id:'o1',year:2030,name:'reform',amount:3000000}];
  normalizeLifeplanBaseline(lifeplan);
`;

const slim = (rows) => rows.map((r) => [r.year, r.age, Math.round(r.income), Math.round(r.expense), Math.round(r.cash), Math.round(r.totalAssets), Math.round(r.investWithdrawal)]);

module.exports = function (t) {
  t('lifeplan: 63-year projection matches the golden file', () => {
    const app = loadApp(); app.run(SCENARIO);
    const rows = slim(app.run('computeLifePlanProjection()'));
    if (process.env.UPDATE_GOLDEN === '1' || !fs.existsSync(GOLDEN)) fs.writeFileSync(GOLDEN, JSON.stringify(rows));
    assert.deepStrictEqual(rows, JSON.parse(fs.readFileSync(GOLDEN, 'utf8')));
  });

  t('lifeplan: pension is inflated up to retirement, then stays flat', () => {
    const app = loadApp(); app.run(SCENARIO);
    app.run(`lifeplan.baseline.self.monthlyIncome=0; lifeplan.baseline.spouse={monthlyIncome:0,incomeGrowthMode:'rate',incomeGrowthRate:0,incomeGrowthFixed:0,leaves:[]}; lifeplan.retirementBonus.amount=0;`);
    const rows = app.run('computeLifePlanProjection()');
    const expected = 3000000 * Math.pow(1.015, 27);
    [65, 66, 80, 100].forEach((age) => assert.ok(Math.abs(rows.find((r) => r.age === age).income - expected) < 1, `age ${age}`));
  });

  t('lifeplan: a younger spouse keeps working; pensions start at each person\'s own retirement; living cost switches when both retire', () => {
    const app = loadApp(); app.run(SCENARIO);
    app.run('lifeplan.spouseAge = 34;');
    const rows = app.run('computeLifePlanProjection()');
    const r65 = rows.find((r) => r.age === 65), r68 = rows.find((r) => r.age === 68), r69 = rows.find((r) => r.age === 69);
    assert.deepStrictEqual([r65.selfRetired, r65.spouseRetired, r65.isRetired], [true, false, false]);
    assert.strictEqual(r69.isRetired, true);
    assert.ok('老後の生活費' in r69.expenseGroups && !('老後の生活費' in r68.expenseGroups));
    const pensionSelf = 3000000 * 0.5 * Math.pow(1.015, 27), pensionSpouse = 3000000 * 0.5 * Math.pow(1.015, 31);
    const spouseSalary = (i) => app.run(`computePersonIncomeForYear(lifeplan.baseline.spouse, ${2026 + i}, ${i})`);
    assert.ok(Math.abs(r68.income - (pensionSelf + spouseSalary(30))) < 1);
    assert.ok(Math.abs(r69.income - (pensionSelf + pensionSpouse)) < 1);
  });

  t('lifeplan: the retirement bonus is reported separately and included in income once', () => {
    const app = loadApp(); app.run(SCENARIO);
    const rows = app.run('computeLifePlanProjection()');
    assert.strictEqual(rows.filter((r) => r.bonus > 0).length, 1);
    const r = rows.find((x) => x.bonus > 0);
    assert.strictEqual(r.bonus, 15000000);
    assert.strictEqual(r.age, 65);
  });

  t('lifeplan: cash is topped up to the reserve from the chosen buckets in order taxable -> growth -> tsumitate', () => {
    const app = loadApp(); app.run(SCENARIO);
    app.run(`lifeplan.initialCash = 0; lifeplan.minCashReserve = 5000000; lifeplan.withdrawTypes = ['nisa_tsumitate','taxable','nisa_growth'];`);
    const w = app.run('computeLifePlanProjection()')[0];
    assert.deepStrictEqual(Object.keys(w.withdrawalParts), ['taxable', 'nisa_growth', 'nisa_tsumitate']);
    assert.strictEqual(Math.round(w.withdrawalParts.taxable), 936000);   // 課税口座は残高すべて
    assert.strictEqual(Math.round(w.withdrawalParts.nisa_growth), 760000);
    assert.ok(w.investWithdrawal > 0);
  });

  t('lifeplan: with no drawdown source selected, cash is allowed to go below the reserve', () => {
    const app = loadApp(); app.run(SCENARIO);
    app.run(`lifeplan.initialCash = 0; lifeplan.minCashReserve = 5000000; lifeplan.withdrawTypes = [];`);
    const w = app.run('computeLifePlanProjection()')[0];
    assert.strictEqual(w.investWithdrawal, 0);
    assert.ok(w.belowReserve);
  });

  t('lifeplan: expense groups add up to total expense, and parts add up to their group', () => {
    const app = loadApp(); app.run(SCENARIO);
    app.run('lifeplan.spouseAge = 34;');
    app.run('computeLifePlanProjection()').forEach((r) => {
      const sum = Object.values(r.expenseGroups).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - r.expense) < 1, `year ${r.year}`);
      Object.keys(r.expenseGroups).forEach((g) => {
        const parts = Object.values(r.expenseParts[g]).reduce((a, b) => a + b, 0);
        assert.ok(Math.abs(parts - r.expenseGroups[g]) < 0.5, `${r.year} ${g}`);
      });
    });
  });

  t('validation: a sane plan and the default plan pass', () => {
    const app = loadApp(); app.run(SCENARIO);
    assert.strictEqual(app.run('validateLifeplan(lifeplan).length'), 0);
    assert.strictEqual(app.run('(()=>{ const d = defaultLifeplan(); normalizeLifeplanBaseline(d); return validateLifeplan(d).length; })()'), 0);
  });

  t('validation: nonsense values are rejected with the field id', () => {
    const app = loadApp(); app.run(SCENARIO);
    const bad = (mut) => app.run(`(()=>{ const snap = JSON.parse(JSON.stringify(lifeplan)); ${mut}; const e = validateLifeplan(lifeplan).map(x=>x.id); lifeplan = snap; return e; })()`);
    assert.ok(bad('lifeplan.currentAge = 150').includes('lpAge'));
    assert.ok(bad('lifeplan.inflationRate = 40').includes('lpInflation'));
    assert.ok(bad('lifeplan.initialCash = -1').includes('lpInitialCash'));
    assert.ok(bad('lifeplan.retirement.retireAge = 10').includes('lpRetireAge'));
    assert.ok(bad('lifeplan.retirement.pensionAnnual = -5').includes('lpPension'));
    assert.ok(bad('lifeplan.expenses.foodMonthly = -100').includes('lpFood'));
    assert.ok(bad('lifeplan.mortgage.years = 80').includes('lpMortgageYears'));
    assert.ok(bad('lifeplan.baseline.self.incomeGrowthRate = 200').includes('lpSelfGrowthRate'));
    assert.ok(bad('lifeplan.children[0].birthYear = 1900').length > 0);
    assert.ok(bad('lifeplan.investments[0].returnRate = 90').length > 0);
    assert.strictEqual(app.run("validateEntryInput('2026-09-21', 1000)"), '');
    assert.notStrictEqual(app.run("validateEntryInput('1999-12-31', 1000)"), '');
    assert.notStrictEqual(app.run("validateEntryInput('2026-09-21', 1e10)"), '');
  });

  t('migrations: old default names and new categories are filled in without clobbering custom ones', () => {
    const app = loadApp();
    assert.deepStrictEqual(app.run("migratePeopleNames({self:'自分',spouse:'配偶者'})"), { self: 'ホスト', spouse: 'ゲスト' });
    assert.deepStrictEqual(app.run("migratePeopleNames({self:'太郎',spouse:'花子'})"), { self: '太郎', spouse: '花子' });
    const c = app.run("migrateCategories({expense:['食費','その他'],income:['給与']})");
    assert.ok(c.expense.includes('積立投資') && c.expense.includes('美容費') && c.expense.includes('被服及び履物費'));
    assert.ok(c.expense.indexOf('積立投資') < c.expense.indexOf('その他'));
  });

  t('sync helpers: pending ops overlay a server snapshot; ids are de-duplicated; fixed logs merge', () => {
    const app = loadApp();
    const out = app.run(`(()=>{
      const server = [{id:'a',amount:1},{id:'b',amount:2},{id:'b',amount:2}];
      const uniq = uniqueById(server);
      const merged = applyPendingEntryOps(uniq, [
        {seq:1, action:'addEntry', payload:{id:'c', amount:3}},
        {seq:2, action:'updateEntry', payload:{id:'a', amount:10}},
        {seq:3, action:'deleteEntry', payload:{id:'b'}},
      ]);
      return { uniq: uniq.map(e=>e.id), merged: merged.map(e=>e.id+':'+e.amount).sort(),
               log: mergeFixedLogs({f1:['2026-07']}, {f1:['2026-08'], f2:['2026-08']}), months: countFixedLogMonths({f1:['x','y'], f2:['z']}) };
    })()`);
    assert.deepStrictEqual(out.uniq, ['a', 'b']);
    assert.deepStrictEqual(out.merged, ['a:10', 'c:3']);
    assert.deepStrictEqual(out.log, { f1: ['2026-07', '2026-08'], f2: ['2026-08'] });
    assert.strictEqual(out.months, 3);
  });

  t('outbox: only one pending setState per key is kept; entry operations keep their order', () => {
    const app = loadApp();
    app.run("config.gasUrl = ''; outbox = [];");
    app.run(`enqueueOutbox('setState', {key:'lifeplan', value:'1'}); enqueueOutbox('addEntry', {id:'x'}); enqueueOutbox('setState', {key:'lifeplan', value:'2'}); enqueueOutbox('deleteEntry', {id:'x'});`);
    const ops = app.run("outbox.map(o=>o.action+':'+(o.payload.key||o.payload.id)+':'+(o.payload.value||''))");
    assert.deepStrictEqual(ops, ['addEntry:x:', 'setState:lifeplan:2', 'deleteEntry:x:']);
  });

  t('fixed costs: ids are deterministic, so generating twice or on two devices never duplicates', () => {
    const app = loadApp();
    app.run(`fixedCosts = [{id:'fxA', type:'expense', person:'self', category:'住居費', amount:50000, dayOfMonth:1, memo:'', startMonth:'2026-08'}]; fixedLog = {}; entries = [];`);
    app.run('generateFixedEntries(); generateFixedEntries();');
    assert.deepStrictEqual(app.run('entries.map(e=>e.id)'), ['fx_fxA_2026-08', 'fx_fxA_2026-09']);
    // 別の端末（空の状態）でも同じIDになる
    app.run('fixedLog = {}; entries = []; generateFixedEntries();');
    assert.deepStrictEqual(app.run('entries.map(e=>e.id)'), ['fx_fxA_2026-08', 'fx_fxA_2026-09']);
  });

  t('fixed costs: legacy duplicates are removed only when every field matches', () => {
    const app = loadApp();
    app.run(`config.gasUrl=''; outbox=[]; entries = [
      {id:'e111', date:'2026-09-01', person:'self', type:'expense', category:'住居費', amount:50000, fixedId:'fxA', createdAt:'2026-09-01T00:00:01Z'},
      {id:'e222', date:'2026-09-01', person:'self', type:'expense', category:'住居費', amount:50000, fixedId:'fxA', createdAt:'2026-09-01T00:00:02Z'},
      {id:'e333', date:'2026-09-01', person:'self', type:'expense', category:'住居費', amount:51000, fixedId:'fxA', createdAt:'2026-09-01T00:00:03Z'},
      {id:'manual1', date:'2026-09-01', person:'self', type:'expense', category:'住居費', amount:50000, createdAt:'2026-09-01T00:00:04Z'}];`);
    app.run('dedupeFixedEntries();');
    assert.deepStrictEqual(app.run('entries.map(e=>e.id).sort()'), ['e111', 'e333', 'manual1']);
  });

  t('ledger: 積立投資 is counted apart from spending', () => {
    const app = loadApp();
    const m = app.run(`(()=>{ const list=[
      {date:'2026-09-01',type:'income',category:'給与',amount:400000},
      {date:'2026-09-03',type:'expense',category:'食費',amount:58000},
      {date:'2026-09-04',type:'expense',category:'積立投資',amount:50000}];
      return aggregateByMonth(list)['2026-09']; })()`);
    assert.deepStrictEqual(m, { income: 400000, expense: 58000, invest: 50000 });
    const a = app.run(`(()=>{ entries=[
      {date:'2026-09-01',type:'income',category:'給与',amount:300000,person:'self'},
      {date:'2026-09-03',type:'expense',category:'食費',amount:30000,person:'self'},
      {date:'2026-09-04',type:'expense',category:'積立投資',amount:60000,person:'self'}];
      return computeAnalysis('2026-09','2026-09','combined'); })()`);
    assert.strictEqual(a.avgExpense, 30000);
    assert.strictEqual(a.avgInvest, 60000);
    assert.strictEqual(a.expenseRows.some((r) => r.category === '積立投資'), false);
  });

  t('sync: pull keeps an unsent local entry and reports failure without touching data', async () => {
    const app = loadApp();
    app.run(`config.gasUrl='https://fake.test/exec'; config.gasSecret='s'; entries=[{id:'local1',date:'2026-09-01',type:'expense',category:'食費',amount:1,person:'self',memo:'',createdAt:'x'}]; outbox=[{seq:1,action:'addEntry',payload:entries[0]}]; outboxSeq=1;`);
    // サーバーは「ローカル入力をまだ知らない」スナップショットを返し、書き込みは混雑で失敗する
    app.ctx.fetch = async (url, o) => {
      const b = o && o.body ? JSON.parse(o.body) : {};
      if (b.action === 'readAll') return { json: async () => ({ status: 'ok', entries: [{ id: 'srv1', date: '2026-09-02', type: 'expense', category: '食費', amount: 2, person: 'spouse' }], state: {} }) };
      return { json: async () => ({ status: 'error', error: 'busy' }) };
    };
    const ok = await app.run('pullFromGAS()');
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(app.run('entries.map(e=>e.id).sort()'), ['local1', 'srv1']);
    assert.strictEqual(app.run('outbox.length'), 1);
    app.ctx.fetch = async () => ({ json: async () => ({ status: 'error', error: 'unauthorized' }) });
    assert.strictEqual(await app.run('pullFromGAS()'), false);
  });

  t('sync: readAll is read over POST; an old GAS without it falls back to GET', async () => {
    const app = loadApp();
    app.run(`config.gasUrl='https://fake.test/exec'; config.gasSecret='s'; outbox=[]; entries=[];`);
    const calls = [];
    app.ctx.fetch = async (url, o) => {
      calls.push((o && o.method) || 'GET');
      const b = o && o.body ? JSON.parse(o.body) : {};
      if (b.action === 'readAll') return { json: async () => ({ status: 'error', error: 'unknown action: readAll' }) };
      return { json: async () => ({ status: 'ok', entries: [{ id: 'g1', date: '2026-09-02', type: 'expense', category: '食費', amount: 2, person: 'self' }], state: {} }) };
    };
    assert.strictEqual(await app.run('pullFromGAS()'), true);
    assert.deepStrictEqual(calls, ['POST', 'GET']);
    assert.strictEqual(app.run('entries.length'), 1);
  });
};
