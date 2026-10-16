'use strict';

// 代码审查复现脚本：仅用虚构数据、内存 SQLite 和模拟请求。
// 断言的是已发现的问题，不是要求保留这些行为的回归测试。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
// 固定读取修复前的历史源码，避免把“复现缺陷”的断言当成修复后的正确行为。
const source = require('node:child_process').execFileSync('git', ['-c', 'safe.directory=' + root, 'show', 'a73574f:app.js'],
  { cwd: root, encoding: 'utf8' }).split('/* ---------- 启动 ---------- */')[0];
const initSqlJs = require(path.join(root, 'vendor/sql-wasm.js'));

async function main() {
  const SQL = await initSqlJs();
  const contexts = [];
  function app() {
    const storage = new Map(), timers = new Map();
    let timerId = 0;
    const ctx = vm.createContext({
      localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
      document: { getElementById: () => null, querySelector: () => ({ dataset: { t: 'spend' } }) },
      navigator: { onLine: true },
      setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
      clearTimeout: id => timers.delete(id),
      btoa: s => Buffer.from(s, 'binary').toString('base64'),
      atob: s => Buffer.from(s, 'base64').toString('binary'),
      SQLModule: SQL
    });
    vm.runInContext(source, ctx, { filename: 'app.js' });
    vm.runInContext('SQL=SQLModule; db=new SQL.Database(); migrate(db);', ctx);
    ctx.run("INSERT INTO cards(id,bank,total,fixed,temporary,available,billDay,repayDay) VALUES(1,'测试',20000,20000,0,1000,'每月22号','固定：2026-10-11')");
    ctx.persist = async () => {};
    ctx.persistNow = async () => {};
    ctx.todayStr = () => '2026-10-15';
    ctx.toast = () => {};
    ctx.renderAll = () => {};
    ctx.openCard = () => {};
    ctx.setModal = () => {};
    ctx.closeM = () => {};
    ctx.go = () => {};
    contexts.push(ctx);
    return { ctx, timers };
  }
  const add = (ctx, type, date, amount) => ctx.addTransaction(1, { type, date, amount });
  const summary = [];
  function found(id, detail) { summary.push({ id, detail }); }

  {
    const { ctx } = app();
    await add(ctx, 'spend', '2026-08-25', 6000);
    await add(ctx, 'spend', '2026-09-25', 5900);
    await add(ctx, 'repayment', '2026-10-15', 6000);
    const card = ctx.getCard(1);
    const old = ctx.cycleDue(card, ctx.parseDate('2026-09-22'), '2026-10-15');
    const next = ctx.cycleDue(card, ctx.parseDate('2026-10-22'), '2026-10-23');
    assert.equal(old.need, 0);
    assert.equal(next.need, 0);
    assert.equal(next.paid, 6000);
    found('R1', '10/15 补还旧账 6000 后，下一期 5900 也被算成还差 0；同一笔还款被两期使用。');
  }
  {
    const { ctx } = app();
    await add(ctx, 'spend', '2026-08-25', 6000);
    const card = ctx.getCard(1);
    assert.equal(ctx.overdueInfo(card, '2026-10-15').remain, 6000);
    assert.equal(ctx.overdueInfo(card, '2026-11-12'), null);
    found('R2', '没有任何还款：10/15 提醒逾期 6000，11/12 返回无逾期。');
  }
  {
    const { ctx } = app();
    ctx.run('UPDATE cards SET total=10000,available=9500 WHERE id=1');
    await add(ctx, 'repayment', '2026-10-11', 1000);
    assert.equal(ctx.getCard(1).available, 10000);
    await ctx.deleteTransaction(1);
    assert.equal(ctx.getCard(1).available, 9000);
    found('R3', '可用 9500，记还款 1000 后封顶 10000，删除该笔后变成 9000，未恢复 9500。');
  }
  {
    const { ctx } = app();
    ctx.run('UPDATE cards SET total=10000,available=10000 WHERE id=1');
    ctx.val = key => ({ recAmt: '100', recDate: '2026-10-15', recNote: '' })[key];
    const writes = [];
    ctx.persist = () => new Promise(resolve => writes.push(resolve));
    const first = ctx.saveRecord(1);
    const second = ctx.saveRecord(1);
    assert.equal(ctx.allTx().length, 2);
    writes.forEach(resolve => resolve());
    await Promise.all([first, second]);
    assert.equal(ctx.getCard(1).available, 9800);
    found('R4', '第一次保存尚未完成时再次点保存，100 元消费入库两次，额度减少 200。');
  }
  {
    const { ctx, timers } = app();
    ctx.ghCfg = () => ({ user: 'mock-user', repo: 'mock-repo', token: 'mock-token' });
    ctx.ghReady = () => true;
    const remote = new SQL.Database(vm.runInContext('db.export()', ctx));
    remote.run("UPDATE cards SET bank='云端独有修改' WHERE id=1");
    ctx.ghFetchDbBytes = async () => ({ status: 200, bytes: remote.export() });
    let conflictShown = false, uploaded = false;
    ctx.setModal = title => { if (title === '数据不一致,请选择') conflictShown = true; };
    ctx.ghRequest = async (_cfg, method, body) => {
      if (method === 'GET') return { ok: true, json: async () => ({ sha: 'remote-current-sha' }) };
      uploaded = true;
      const sent = new SQL.Database(Buffer.from(body.content, 'base64'));
      assert.equal(sent.exec('SELECT bank FROM cards')[0].values[0][0], '测试');
      sent.close();
      return { ok: true };
    };
    ctx.setDirty(true);
    ctx.scheduleAutoSync();
    await ctx.syncOnOpen();
    assert.equal(conflictShown, true);
    assert.ok(vm.runInContext('pendingCloudBytes !== null', ctx));
    const queued = [...timers.values()]; timers.clear();
    for (const fn of queued) await fn();
    assert.equal(uploaded, true);
    assert.ok(vm.runInContext('pendingCloudBytes !== null', ctx));
    remote.close();
    found('R5', '冲突弹窗仍等待选择，之前排队的自动同步已经上传本机快照、覆盖云端。请求全程模拟。');
  }
  {
    const { ctx } = app();
    const legacy = new SQL.Database();
    const original = vm.runInContext('db', ctx);
    legacy.run('CREATE TABLE credit_cards(id INTEGER,bank TEXT,creditLimit REAL,available REAL)');
    legacy.run("INSERT INTO credit_cards VALUES(1,'旧卡一',10000,9000),(1,'旧卡二',10000,9000)");
    assert.throws(() => ctx.loadBytesIntoDb(legacy.export()), /UNIQUE constraint failed/);
    assert.notEqual(vm.runInContext('db', ctx), original);
    assert.throws(() => ctx.getCards());
    assert.equal(original.exec('SELECT COUNT(*) FROM cards')[0].values[0][0], 1);
    original.close();
    legacy.close();
    found('R6', '旧格式导入因重复 id 失败后，全局 db 指向已关闭的新库，原本账本也无法继续查询，需刷新。');
  }
  {
    const { ctx } = app();
    await ctx.saveInst(1, null, { principal: 10000, periods: 12, remaining: 12, perPrincipal: 1000, perFee: 0, startDate: '2026-10-15' });
    const plan = ctx.instInfo(ctx.getInst(1, 1)).plan;
    assert.equal(plan.at(-1).p, -1000);
    found('R7', '本金 10000、12 期、每期本金手填 1000 可保存，生成末期本金 -1000 的负数账单。');
  }
  {
    const { ctx } = app();
    await ctx.saveInst(1, null, { principal: 1200, periods: 12, remaining: 12, startDate: '2026-09-01' });
    const bytes = vm.runInContext('db.export()', ctx);
    const target = app().ctx;
    target.ghReady = () => true;
    target.ghFetchDbBytes = async () => ({ status: 200, bytes });
    await target.pullFromCloud();
    assert.equal(target.allInsts().length, 1);
    assert.equal(target.allTx().length, 0);
    assert.equal(await target.catchUpInstallments(), 2);
    found('R8', '云端恢复含 9/1 起分期的数据后，10/15 仍有 0 条分期流水；手动调用补记才生成应有的 2 期。');
  }
  for (const ctx of contexts) {
    try { vm.runInContext('db.close()', ctx); } catch (_) {}
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
