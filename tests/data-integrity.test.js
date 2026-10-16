'use strict';
const assert = require('node:assert/strict');
const { test, before } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').split('/* ---------- 启动 ---------- */')[0];
let SQL;
before(async () => { SQL = await require('../vendor/sql-wasm.js')(); });

function app(t) {
  const storage = new Map(), timers = new Map(), elements = { recSave: { disabled: false } }, messages = [], snapshots = [];
  let timerId = 0, form = {}, type = 'spend';
  const ctx = vm.createContext({
    localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    document: { getElementById: id => elements[id] || null, querySelector: () => ({ dataset: { t: type } }) },
    navigator: { onLine: true }, setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    btoa: s => Buffer.from(s, 'binary').toString('base64'), atob: s => Buffer.from(s, 'base64').toString('binary'), SQLModule: SQL
  });
  vm.runInContext(source, ctx, { filename: 'app.js' });
  vm.runInContext('SQL=SQLModule; db=new SQL.Database(); migrate(db); unlocked=true;', ctx);
  ctx.run("INSERT INTO cards(id,bank,total,fixed,temporary,available,billDay,repayDay) VALUES(1,'测试',20000,20000,0,1000,'每月22号','固定：2026-10-11')");
  ctx.todayStr = () => '2026-10-15';
  ctx.persistNow = async () => { snapshots.push(vm.runInContext('db.export()', ctx)); };
  ctx.toast = message => messages.push(message);
  ctx.renderAll = () => ctx.resetOverdueCache();
  ctx.openCard = ctx.closeM = ctx.go = () => {};
  ctx.setModal = title => messages.push(title);
  ctx.val = key => form[key] || '';
  t.after(() => { try { vm.runInContext('db.close()', ctx); } catch (_) {} });
  return { ctx, timers, elements, messages, snapshots, setForm: (values, txType = 'spend') => { form = values; type = txType; } };
}
const add = (ctx, type, date, amount, extra = {}) => ctx.addTransaction(1, { type, date, amount, ...extra });
const bytes = ctx => vm.runInContext('db.export()', ctx);
const state = (ctx, expression) => vm.runInContext(expression, ctx);
function remote(ctx, initialBytes) {
  const server = { sha: 'v1', bytes: initialBytes, puts: [], reads: 0 };
  ctx.ghCfg = () => ({ user: 'mock', repo: 'backup', token: 'not-a-real-token' });
  ctx.ghFetchDbBytes = async () => ({ status: server.sha === null ? 404 : 200, bytes: server.bytes });
  ctx.ghRequest = async (_cfg, method, body) => {
    if (method === 'GET') {
      server.reads++;
      if (server.onRead) await server.onRead();
      return { status: server.sha === null ? 404 : 200, ok: server.sha !== null, json: async () => ({ sha: server.sha }) };
    }
    if (server.onPut) return server.onPut(body);
    assert.equal(body.sha || null, server.sha);
    server.puts.push(body);
    server.bytes = new Uint8Array(Buffer.from(body.content, 'base64'));
    server.sha = 'v' + (server.puts.length + 1);
    return { ok: true, status: 200, json: async () => ({ content: { sha: server.sha } }) };
  };
  return server;
}
function changedCloud(ctx) {
  const db = new SQL.Database(bytes(ctx));
  db.run("UPDATE cards SET bank='云端更新' WHERE id=1");
  const result = db.export(); db.close(); return result;
}

test('R1：逾期补还只结清旧账，下一期仍需还款', async t => {
  const { ctx } = app(t);
  await add(ctx, 'spend', '2026-08-25', 6000);
  await add(ctx, 'spend', '2026-09-25', 5900);
  await add(ctx, 'repayment', '2026-10-15', 6000);
  const c = ctx.getCard(1);
  assert.equal(ctx.cycleDue(c, ctx.parseDate('2026-09-22'), '2026-10-15').need, 0);
  const next = ctx.cycleDue(c, ctx.parseDate('2026-10-22'), '2026-10-23');
  assert.equal(next.paid, 0); assert.equal(next.need, 5900);
});
test('R1：一笔还两期按旧账优先分配，差额拆分不吞掉另一期', async t => {
  const { ctx, setForm } = app(t);
  await add(ctx, 'spend', '2026-08-25', 6000);
  await add(ctx, 'spend', '2026-09-25', 5900);
  setForm({ recAmt: '11940', recDate: '2026-10-15' }, 'repayment');
  await ctx.saveRecord(1);
  assert.equal(ctx.allTx().find(x => x.note === '还款差额').amount, 40);
  assert.equal(ctx.overdueInfo(ctx.getCard(1), '2026-11-12'), null);
  const ledger = ctx.repaymentLedger(ctx.getCard(1), '2026-11-12');
  assert.equal(ledger.reduce((n, x) => n + x.paid, 0), 11900);
});
test('R2：无新消费的旧账数月后仍提醒，部分偿还后剩余正确', async t => {
  const { ctx } = app(t);
  await add(ctx, 'spend', '2026-08-25', 6000);
  assert.equal(ctx.overdueInfo(ctx.getCard(1), '2027-03-15').remain, 6000);
  await add(ctx, 'repayment', '2027-03-16', 1500);
  const late = ctx.overdueInfo(ctx.getCard(1), '2027-03-17');
  assert.equal(late.repay, '2026-10-11'); assert.equal(late.remain, 4500);
});
test('R2：多期欠款合计且保持最早逾期日期，列表与详情一致', async t => {
  const { ctx } = app(t);
  await add(ctx, 'spend', '2026-08-25', 6000);
  await add(ctx, 'spend', '2026-09-25', 5900);
  ctx.todayStr = () => '2026-11-12';
  assert.equal(ctx.cardNeed(ctx.getCard(1)), 11900);
  const late = ctx.overdueInfo(ctx.getCard(1));
  assert.equal(late.repay, '2026-10-11'); assert.equal(late.cycles.length, 2);
  assert.match(ctx.cardCycleRowsHTML(ctx.getCard(1)), /另有逾期 ¥6,000/);
  assert.doesNotMatch(ctx.cardCycleRowsHTML(ctx.getCard(1)), /另有逾期 ¥11,900/);
});
test('R3：触及额度上限的还款和下限的消费撤销后恢复原值', async t => {
  const { ctx } = app(t);
  for (const [type, available, amount] of [['repayment', 9500, 1000], ['spend', 500, 1000]]) {
    ctx.run('UPDATE cards SET total=10000,available=? WHERE id=1', [available]);
    const id = await add(ctx, type, '2026-10-11', amount);
    assert.equal(Math.abs(ctx.allTx()[0].availableDelta), 500);
    await ctx.deleteTransaction(id);
    assert.equal(ctx.getCard(1).available, available);
  }
});
test('R3：不动额度还款撤销也不动额度，旧库升级保留记录和余额', async t => {
  const { ctx } = app(t);
  const id = await add(ctx, 'repayment', '2026-10-11', 1000, { note: '还款(额度已手改)', limitAmount: 0 });
  assert.equal(ctx.allTx()[0].availableDelta, 0);
  await ctx.deleteTransaction(id); assert.equal(ctx.getCard(1).available, 1000);
  const legacy = new SQL.Database(bytes(ctx));
  legacy.run('ALTER TABLE transactions DROP COLUMN availableDelta');
  legacy.run("INSERT INTO transactions(id,cardId,date,amount,type) VALUES(1,1,'2026-10-11',100,'repayment')");
  ctx.loadBytesIntoDb(legacy.export()); legacy.close();
  assert.equal(ctx.getCard(1).available, 1000);
  assert.equal(ctx.allTx()[0].availableDelta, null);
  assert.equal(ctx.needsBalanceCheck(ctx.allTx()[0]), true);
  await ctx.deleteTransaction(1); assert.equal(ctx.getCard(1).available, 1000);
});
test('R4：连续保存只入账一次，保存按钮期间禁用', async t => {
  const { ctx, setForm, elements } = app(t);
  let finish;
  ctx.persistNow = () => new Promise(resolve => { finish = resolve; });
  setForm({ recAmt: '100', recDate: '2026-10-15' });
  const first = ctx.saveRecord(1);
  assert.equal(elements.recSave.disabled, true);
  await ctx.saveRecord(1);
  assert.equal(ctx.allTx().length, 1);
  finish(); await first;
  assert.equal(elements.recSave.disabled, false);
});
test('R4：两笔拆分只持久化一次，SQL 写入失败时整组回滚', async t => {
  const { ctx, snapshots } = app(t);
  await ctx.addTransactions(1, [{ type: 'repayment', date: '2026-10-15', amount: 100 }, { type: 'repayment', date: '2026-10-15', amount: 5, limitAmount: 0, note: '还款差额' }]);
  assert.equal(snapshots.length, 1);
  const before = ctx.getCard(1).available;
  ctx.run("CREATE TRIGGER fail_second BEFORE INSERT ON transactions WHEN NEW.note='bad' BEGIN SELECT RAISE(ABORT,'injected'); END");
  await assert.rejects(ctx.addTransactions(1, [{ type: 'spend', date: '2026-10-15', amount: 20 }, { type: 'spend', date: '2026-10-15', amount: 20, note: 'bad' }]), /injected/);
  assert.equal(ctx.allTx().length, 2); assert.equal(ctx.getCard(1).available, before);
});
test('R5：冲突检查会取消排队的自动上传，等待选择时禁止上传', async t => {
  const { ctx, timers, messages } = app(t);
  const server = remote(ctx, bytes(ctx));
  await ctx.syncOnOpen();
  ctx.setDirty(true); ctx.scheduleAutoSync();
  assert.equal(timers.size, 1);
  const staleTimer = [...timers.values()][0];
  server.sha = 'changed'; server.bytes = changedCloud(ctx);
  await ctx.syncOnOpen();
  assert.ok(messages.includes('数据不一致,请选择')); assert.equal(timers.size, 0);
  await staleTimer(); await ctx.doSync();
  assert.equal(server.puts.length, 0); assert.ok(state(ctx, 'pendingCloudBytes'));
});
test('R5：登录前补记产生的改动不会自动上传', async t => {
  const { ctx, timers } = app(t);
  const server = remote(ctx, changedCloud(ctx));
  state(ctx, 'unlocked=false');
  await add(ctx, 'spend', '2026-10-15', 100);
  await ctx.doSync({ automatic: true });
  assert.equal(timers.size, 0); assert.equal(server.puts.length, 0);
});
test('R5：检查后远端再次变化，不使用新 SHA 盲目覆盖', async t => {
  const { ctx } = app(t);
  const server = remote(ctx, bytes(ctx));
  await ctx.syncOnOpen();
  await add(ctx, 'spend', '2026-10-15', 100);
  server.sha = 'v2'; server.bytes = changedCloud(ctx);
  assert.equal(await ctx.doSync(), false);
  assert.equal(server.puts.length, 0); assert.ok(state(ctx, 'pendingCloudBytes'));
});
test('R5：明确选择本机后仅上传所确认版本，上传失败保留冲突', async t => {
  const { ctx } = app(t);
  const server = remote(ctx, changedCloud(ctx));
  await ctx.syncOnOpen();
  server.onPut = () => ({ ok: false, status: 500 });
  await ctx.resolveSyncUseLocal();
  assert.ok(state(ctx, 'pendingCloudBytes')); assert.equal(state(ctx, 'syncRunning'), false);
  server.onPut = null;
  await ctx.resolveSyncUseLocal();
  assert.equal(server.puts.length, 1); assert.equal(server.puts[0].sha, 'v1');
  assert.equal(state(ctx, 'pendingCloudBytes'), null); assert.equal(state(ctx, 'dirty'), false);
});
test('R5：网络或版本冲突失败不会无限重试覆盖', async t => {
  const { ctx, timers } = app(t);
  const server = remote(ctx, bytes(ctx));
  await ctx.syncOnOpen(); await add(ctx, 'spend', '2026-10-15', 100);
  server.onPut = () => { server.sha = 'v3'; server.bytes = changedCloud(ctx); return { ok: false, status: 409 }; };
  await ctx.doSync();
  assert.equal(server.puts.length, 0); assert.ok(state(ctx, 'pendingCloudBytes')); assert.equal(timers.size, 0);
});
test('R6：旧格式重复 ID 导入失败后原库仍可查询和记账', async t => {
  const { ctx } = app(t);
  const original = state(ctx, 'db');
  const legacy = new SQL.Database();
  legacy.run('CREATE TABLE credit_cards(id INTEGER,bank TEXT,creditLimit REAL,available REAL)');
  legacy.run("INSERT INTO credit_cards VALUES(1,'甲',10000,9000),(1,'乙',10000,9000)");
  assert.throws(() => ctx.loadBytesIntoDb(legacy.export()), /UNIQUE/); legacy.close();
  assert.equal(state(ctx, 'db'), original); assert.equal(ctx.getCard(1).bank, '测试');
  await add(ctx, 'spend', '2026-10-15', 100); assert.equal(ctx.allTx().length, 1);
});
test('R6/R8：恢复持久化失败保留原库及同步状态', async t => {
  const { ctx } = app(t);
  const original = state(ctx, 'db'), cloud = changedCloud(ctx);
  ctx.setDirty(true); ctx.persistNow = async () => { throw new Error('disk full'); };
  await assert.rejects(ctx.replaceDatabase(cloud), /disk full/);
  assert.equal(state(ctx, 'db'), original); assert.equal(ctx.getCard(1).bank, '测试');
  assert.equal(state(ctx, 'dirty'), true); assert.equal(state(ctx, 'databaseReplacing'), false);
});
test('R7：不一致的分期本金无法保存，异常历史分期不会生成负数流水', async t => {
  const { ctx, messages } = app(t);
  const input = { principal: 10000, periods: 12, perPrincipal: 1000, remaining: 12, startDate: '2026-01-01' };
  await assert.rejects(ctx.saveInst(1, null, input), /负数末期/);
  assert.equal(ctx.allInsts().length, 0);
  ctx.run("INSERT INTO installments(id,cardId,principal,periods,perPrincipal,startDate,status) VALUES(1,1,10000,12,1000,'2026-01-01','active')");
  assert.equal(await ctx.catchUpInstallments(), 0); assert.equal(ctx.allTx().length, 0);
  assert.match(ctx.instRowHTML(1, ctx.getInst(1, 1)), /参数异常/);
  assert.ok(messages.some(m => m.includes('暂停自动入账')));
});
test('R7：正常等额本金及占额度分期按期入账、金额准确且幂等', async t => {
  const { ctx } = app(t);
  await ctx.saveInst(1, null, { principal: 1200, periods: 12, remaining: 12, startDate: '2026-09-01', feeMode: 'declining', monthRate: 0.01, occupyLimit: true });
  const info = ctx.instInfo(ctx.getInst(1, 1));
  assert.equal(info.plan.reduce((n, x) => n + x.p, 0), 1200);
  assert.ok(Math.abs(info.rate - 0.12) < 1e-8);
  assert.equal(await ctx.catchUpInstallments(), 2);
  assert.deepEqual(Array.from(ctx.allTx(), x => x.amount), [111, 112]);
  assert.equal(ctx.getCard(1).available, 977);
  assert.equal(await ctx.catchUpInstallments(), 0);
});

for (const method of ['import', 'pull', 'empty-login', 'conflict-cloud']) {
  test(`R8：${method} 恢复后立即补记并保留待同步标记`, async t => {
    const sourceApp = app(t).ctx;
    await sourceApp.saveInst(1, null, { principal: 1200, periods: 12, remaining: 12, startDate: '2026-09-01' });
    const backup = bytes(sourceApp);
    const { ctx, elements } = app(t);
    remote(ctx, backup);
    if (method === 'import') {
      elements.impFile = { files: [{ arrayBuffer: async () => backup.slice().buffer }] };
      await ctx.doImport();
    } else if (method === 'pull') await ctx.pullFromCloud();
    else if (method === 'empty-login') { ctx.run('DELETE FROM cards'); await ctx.syncOnOpen(); }
    else { await ctx.syncOnOpen(); assert.ok(state(ctx, 'pendingCloudBytes')); await ctx.resolveSyncUseCloud(); }
    assert.equal(ctx.allTx().length, 2); assert.equal(ctx.getCard(1).available, 800);
    assert.equal(state(ctx, 'dirty'), true);
    assert.equal(await ctx.catchUpInstallments(), 0);
  });
}
test('恢复下载期间新增的本机流水不会被覆盖', async t => {
  const { ctx } = app(t);
  const server = remote(ctx, changedCloud(ctx));
  let resume;
  server.onRead = () => { server.onRead = null; return new Promise(resolve => { resume = resolve; }); };
  const pull = ctx.pullFromCloud();
  await add(ctx, 'spend', '2026-10-15', 100);
  resume(); await pull;
  assert.equal(ctx.getCard(1).bank, '测试'); assert.equal(ctx.allTx().length, 1);
});
