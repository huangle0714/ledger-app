'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// 使用虚构账务数据，加载实际业务函数；不启动页面、不访问本机账务库。
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const startup = source.indexOf('/* ---------- 启动 ---------- */');
assert.ok(startup > 0, '应能在页面启动前加载业务函数');
const card = {
  id: 1, bank: '测试银行', billDay: '每月22号', repayDay: '固定：2026-10-11',
  total: 20000, available: 1000
};
const spend = (date, amount) => ({ cardId: 1, type: 'spend', date, amount });
const pay = (date, amount, extra = {}) => ({ cardId: 1, type: 'repayment', date, amount, ...extra });
const fixture = () => [
  spend('2026-08-25', 6000),
  pay('2026-09-11', 5800),
  pay('2026-09-11', 30, { note: '还款差额', limitAmount: 0 }),
  spend('2026-09-25', 5900)
];

function app(rows, ref = '2026-10-15', cards = [card]) {
  const ctx = vm.createContext({ localStorage: { getItem: () => null } });
  vm.runInContext(source.slice(0, startup), ctx, { filename: 'app.js' });
  ctx.getTx = id => rows.filter(t => t.cardId === id);
  ctx.getCards = () => cards;
  ctx.todayStr = () => ref;
  return ctx;
}

function cycle(ctx, c = card, bill = '2026-09-22', ref = ctx.todayStr()) {
  return ctx.cycleDue(c, ctx.parseDate(bill), ref);
}

test('上一还款日的还款不能抵扣本期，即使上一期消费未录入', () => {
  const ctx = app(fixture());
  const result = cycle(ctx);
  assert.equal(result.due, 6000);
  assert.equal(result.paid, 0);
  assert.equal(result.need, 6000);
  assert.equal(ctx.overdueInfo(card).remain, 6000);
});

test('上一期还款大于本期账单也不能把本期还差压成零', () => {
  const ctx = app([spend('2026-08-25', 6000), pay('2026-09-11', 9000)]);
  assert.equal(cycle(ctx).need, 6000);
  assert.equal(ctx.overdueInfo(card).remain, 6000);
});

test('补齐或缺少更早的流水，不改变本期的应还、已还和还差', () => {
  const a = cycle(app(fixture()));
  const b = cycle(app([spend('2026-07-25', 5800), ...fixture()]));
  for (const key of ['due', 'paid', 'need']) assert.equal(a[key], b[key]);
});

test('消费周期左开右闭，上一还款日当天不计入、次日计入', () => {
  const ctx = app([
    spend('2026-08-22', 900), spend('2026-08-23', 1000),
    spend('2026-09-22', 2000), spend('2026-09-23', 8000),
    pay('2026-09-11', 900), pay('2026-09-12', 500)
  ]);
  const result = cycle(ctx);
  assert.equal(result.due, 3000);
  assert.equal(result.paid, 500);
  assert.equal(result.need, 2500);
});

test('本期多笔部分还款累计，未来还款不计入', () => {
  const ctx = app([...fixture(), pay('2026-10-10', 1000), pay('2026-10-15', 500), pay('2026-10-16', 4500)]);
  assert.equal(cycle(ctx).paid, 1500);
  assert.equal(cycle(ctx).need, 4500);
  assert.equal(ctx.dueToRepay(card).remain, 4500);
});

test('本期到期日还款可结清，次日不再逾期', () => {
  const ctx = app([...fixture(), pay('2026-10-11', 6000)], '2026-10-12');
  assert.equal(cycle(ctx).need, 0);
  assert.equal(ctx.overdueInfo(card), null);
});

test('逾期后补记的还款仍能结清该期', () => {
  const ctx = app([...fixture(), pay('2026-10-15', 6000)]);
  assert.equal(cycle(ctx).paid, 6000);
  assert.equal(cycle(ctx).need, 0);
  assert.equal(ctx.overdueInfo(card), null);
});

test('还款差额只留档，额度已手改的真实还款仍计入', () => {
  const ctx = app([
    ...fixture(), pay('2026-10-11', 40, { note: '还款差额', limitAmount: 0 }),
    pay('2026-10-15', 6000, { note: '还款(额度已手改)', limitAmount: 0 })
  ]);
  assert.equal(cycle(ctx).paid, 6000);
  assert.equal(cycle(ctx).need, 0);
  assert.equal(ctx.overdueInfo(card), null);
});

test('分期的账单金额按 amount 算，实际还款按分精度相减', () => {
  const ctx = app([
    { ...spend('2026-08-25', 1000.35), instId: 1, instPeriod: 1, limitAmount: 0.35 },
    pay('2026-10-10', 700.10), pay('2026-10-11', 300.20)
  ]);
  assert.equal(cycle(ctx).due, 1000.35);
  assert.equal(cycle(ctx).paid, 1000.30);
  assert.equal(cycle(ctx).need, 0.05);
});

test('超过应还的单笔还款不会产生负的还差', () => {
  const ctx = app([...fixture(), pay('2026-10-11', 6100)]);
  assert.equal(cycle(ctx).paid, 6100);
  assert.equal(cycle(ctx).need, 0);
});

test('月末账单和还款日在短月正确截断，排除上一到期日还款', () => {
  const c = { ...card, billDay: '每月31号', repayDay: '固定：2026-01-15' };
  const ctx = app([
    spend('2026-01-31', 500), spend('2026-02-01', 1000), spend('2026-02-28', 2000),
    spend('2026-03-01', 9000), pay('2026-02-15', 5000), pay('2026-03-15', 1000)
  ], '2026-03-16', [c]);
  const result = cycle(ctx, c, '2026-02-28');
  assert.equal(result.prevBill, '2026-01-31');
  assert.equal(result.repay, '2026-03-15');
  assert.equal(result.due, 3000);
  assert.equal(result.paid, 1000);
  assert.equal(result.need, 2000);
});

test('卡片、详情、逾期列表和拆分还款使用一致的还差', () => {
  const ctx = app(fixture());
  assert.equal(ctx.cardNeed(card), 6000);
  assert.equal(ctx.overdueCards()[0].remain, 6000);
  assert.equal(ctx.dueToRepay(card).remain, 6000);
  assert.match(ctx.cardCycleRowsHTML(card), /本期应还<\/span><strong>¥6,000/);
  assert.match(ctx.cardCycleRowsHTML(card), /本期已还<\/span><strong>¥0/);
  assert.match(ctx.cardCycleRowsHTML(card), /本期还差<\/span><strong>¥6,000/);
  let modal;
  ctx.setModal = (title, body) => { modal = body; };
  ctx.showOverdueAlert(ctx.overdueCards());
  assert.match(modal, /due-amt">¥6,000/);
  assert.match(modal, /加起来还要还<\/span><strong>¥6,000/);
  // 还款 6,040 应拆出 40，而不是误把上一期还款也拆成差额。
  assert.equal(ctx.money2(6040 - ctx.repaymentCapacity(card).remain), 40);
});

test('本期无消费、额度回满或缺日期时保持现有行为', () => {
  const ctx = app([pay('2026-09-11', 5000)]);
  assert.equal(cycle(ctx).need, 0);
  assert.equal(ctx.overdueInfo(card), null);
  const full = { ...card, id: 2, available: card.total };
  assert.equal(ctx.cardNeed(full), 0);
  assert.equal(ctx.overdueInfo(full), null);
  const missing = { ...card, id: 3, billDay: '' };
  assert.equal(ctx.cardNeed(missing), null);
  assert.equal(ctx.overdueInfo(missing), null);
  assert.equal(ctx.cardCycleRowsHTML(missing), '');
});
