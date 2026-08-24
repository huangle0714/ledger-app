/* 账务管家 PWA — 本地 SQLite(sql.js) + xyk 功能移植
 * 数据只存本机(IndexedDB 保存 SQLite 二进制),可一键备份到 GitHub 私有仓库。 */
'use strict';

const DEFAULT_FEE_RATE = 0.0025;
const DB_KEY = 'sqlite';
const PASS_KEY = 'ledger-pass';
const GH_KEY = 'ledger-gh';
const SYNC_TIME_KEY = 'ledger-sync-time';
const SYNC_DIRTY_KEY = 'ledger-sync-dirty';
const DEFAULT_PASS = '85168377';
const AUTO_SYNC_DELAY = 1800;
const MARKS = ['blue', 'orange', 'purple', 'teal', 'red'];
const titles = { home: '总览', cards: '我的卡片', repayment: '还款', settings: '设置' };

let SQL = null;      // sql.js 模块
let db = null;       // 当前数据库
let sortKey = 'repayDay';
let selectedDate = todayStr();
let dirty = localStorage.getItem(SYNC_DIRTY_KEY) === '1'; // 本地有未同步改动
let autoSyncTimer = null;
let syncRunning = false;
let syncAgain = false;
let changeVersion = 0;
let unlocked = false; // 是否已通过密码进入(用于登录后再自动拉取)
let lastCatchUp = 0;  // 本次打开自动补记了多少期分期

/* ---------- 基础工具 ---------- */
function pad(n) { return String(n).padStart(2, '0'); }
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function nowTime() { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function nowStamp() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
function yuan(n) { return '¥' + Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: (n % 1) ? 2 : 0, maximumFractionDigits: 2 }); }
function signed(n) { return (n < 0 ? '-' : '+') + '¥' + Math.abs(n).toLocaleString('zh-CN', { minimumFractionDigits: (n % 1) ? 2 : 0, maximumFractionDigits: 2 }); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function markColor(s) { let h = 0; for (const ch of String(s || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return MARKS[h % MARKS.length]; }
function shortName(bank) { return (String(bank || '卡').replace(/银行|信用卡|股份|有限公司/g, '').slice(0, 2)) || '卡'; }
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200); }

/* ---------- IndexedDB(保存 SQLite 二进制) ---------- */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('ledger-store', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbSet(k, v) { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
async function idbGet(k) { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction('kv', 'readonly'); const q = t.objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
/* ---------- SQL 查询封装 ---------- */
function all(sql, params = []) { const s = db.prepare(sql); s.bind(params); const out = []; while (s.step()) out.push(s.getAsObject()); s.free(); return out; }
function run(sql, params = []) { const s = db.prepare(sql); s.bind(params); s.step(); s.free(); }
function scalar(sql, params = []) { const r = all(sql, params); return r.length ? Object.values(r[0])[0] : null; }
function nextId(table) { return (Number(scalar(`SELECT MAX(id) FROM ${table}`)) || 0) + 1; }

/* ---------- 建库 / 载入 / 持久化 ---------- */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards(
  id INTEGER PRIMARY KEY, user TEXT, bank TEXT, name TEXT, tail TEXT,
  total REAL NOT NULL DEFAULT 0, fixed REAL NOT NULL DEFAULT 0, temporary REAL NOT NULL DEFAULT 0,
  available REAL NOT NULL DEFAULT 0, billDay TEXT, repayDay TEXT);
CREATE TABLE IF NOT EXISTS annual_fees(
  id INTEGER, cardId INTEGER, name TEXT, chargeDate TEXT, requirement TEXT, status TEXT, note TEXT,
  PRIMARY KEY(cardId, id));
CREATE TABLE IF NOT EXISTS transactions(
  id INTEGER PRIMARY KEY, cardId INTEGER, date TEXT, time TEXT, createdAt TEXT,
  amount REAL NOT NULL DEFAULT 0, note TEXT, type TEXT, feeRate REAL,
  limitAmount REAL, instId INTEGER, instPeriod INTEGER);
CREATE TABLE IF NOT EXISTS installments(
  id INTEGER, cardId INTEGER, name TEXT, principal REAL NOT NULL DEFAULT 0,
  periods INTEGER NOT NULL DEFAULT 1, postedBase INTEGER NOT NULL DEFAULT 0,
  perPrincipal REAL, perFee REAL, startDate TEXT,
  occupyLimit INTEGER NOT NULL DEFAULT 0, status TEXT, note TEXT,
  PRIMARY KEY(cardId, id));`;

/* 老库升级:全部 CREATE 都带 IF NOT EXISTS,可反复执行;
   transactions 三列用 PRAGMA 探测后单独补,老备份读进来一样走这里 */
function tableCols(target, table) {
  try { const s = target.prepare(`PRAGMA table_info(${table})`); const out = []; while (s.step()) out.push(s.getAsObject().name); s.free(); return out; }
  catch (e) { return []; }
}
function migrate(target) {
  target.exec(SCHEMA);
  const cols = tableCols(target, 'transactions');
  if (!cols.length) return;
  if (!cols.includes('limitAmount')) target.exec('ALTER TABLE transactions ADD COLUMN limitAmount REAL');
  if (!cols.includes('instId')) target.exec('ALTER TABLE transactions ADD COLUMN instId INTEGER');
  if (!cols.includes('instPeriod')) target.exec('ALTER TABLE transactions ADD COLUMN instPeriod INTEGER');
}

function seedFrom(data) {
  db.exec('BEGIN');
  (data.cards || []).forEach(c => run(
    `INSERT INTO cards(id,user,bank,name,tail,total,fixed,temporary,available,billDay,repayDay) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    [c.id, c.user, c.bank, c.name, c.tail, Number(c.total || 0), Number(c.fixed || 0), Number(c.temporary || 0), Number(c.available || 0), c.billDay, c.repayDay]));
  (data.annualFees || []).forEach(f => run(
    `INSERT INTO annual_fees(id,cardId,name,chargeDate,requirement,status,note) VALUES(?,?,?,?,?,?,?)`,
    [f.id, f.cardId, f.name, f.chargeDate, f.requirement, f.status, f.note]));
  (data.transactions || []).forEach(t => run(
    `INSERT INTO transactions(id,cardId,date,time,createdAt,amount,note,type,feeRate,limitAmount,instId,instPeriod) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [t.id, t.cardId, t.date, t.time, t.createdAt, Number(t.amount || 0), t.note, t.type, t.type === 'repayment' ? null : Number(t.feeRate != null ? t.feeRate : DEFAULT_FEE_RATE),
     t.limitAmount != null ? Number(t.limitAmount) : null, t.instId != null ? Number(t.instId) : null, t.instPeriod != null ? Number(t.instPeriod) : null]));
  (data.installments || []).forEach(n => run(
    `INSERT INTO installments(id,cardId,name,principal,periods,postedBase,perPrincipal,perFee,startDate,occupyLimit,status,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [n.id, n.cardId, n.name, Number(n.principal || 0), Number(n.periods || 1), Number(n.postedBase || 0),
     Number(n.perPrincipal || 0), Number(n.perFee || 0), n.startDate, n.occupyLimit ? 1 : 0, n.status || 'active', n.note || '']));
  db.exec('COMMIT');
}

async function openDatabase() {
  SQL = await initSqlJs({ locateFile: f => './vendor/' + f });
  const saved = await idbGet(DB_KEY);
  if (saved && saved.byteLength) {
    db = new SQL.Database(new Uint8Array(saved));
    migrate(db);
  } else {
    db = new SQL.Database();
    migrate(db);
    if (window.SEED_DATA) seedFrom(window.SEED_DATA);
    await persistNow();
  }
}
async function persistNow() { const bytes = db.export(); await idbSet(DB_KEY, bytes); }
function setDirty(value) {
  dirty = Boolean(value);
  if (dirty) localStorage.setItem(SYNC_DIRTY_KEY, '1');
  else localStorage.removeItem(SYNC_DIRTY_KEY);
  updateSyncLabel();
}
async function persist() {
  await persistNow();
  changeVersion += 1;
  setDirty(true);
  scheduleAutoSync();
}
/* ---------- 业务逻辑(忠实移植 xyk) ---------- */
function getFeeRate(t) { const r = Number(t.feeRate); return Number.isFinite(r) && r >= 0 ? r : DEFAULT_FEE_RATE; }
function getFeeAmount(t) { return Number(t.amount || 0) * getFeeRate(t); }
function parseDate(s) { return new Date(`${s}T00:00:00`); }
function fmtDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function monthLen(y, m) { return new Date(y, m + 1, 0).getDate(); }
function dateWithDay(y, m, day) { return new Date(y, m, Math.min(day, monthLen(y, m))); }
function addMonthsClamped(d, m) { return dateWithDay(d.getFullYear(), d.getMonth() + m, d.getDate()); }
function parseBillDay(s) { const m = String(s || '').match(/每月(\d{1,2})号/); return m ? Number(m[1]) : null; }
function parseRepayDate(s) { const m = String(s || '').match(/\d{4}-\d{2}-\d{2}/); return m ? m[0] : null; }
function getRepayMode(s) { return String(s || '').startsWith('顺延') ? '顺延' : '固定'; }
function getEffectiveRepayDate(s, ref = todayStr()) {
  const orig = parseRepayDate(s); if (!orig) return null;
  const r = parseDate(ref); let d = parseDate(orig);
  while (d < r) d = addMonthsClamped(d, 1);
  return fmtDate(d);
}
function getEffectiveRepayDay(c) { const d = getEffectiveRepayDate(c.repayDay); return d ? `${getRepayMode(c.repayDay)}：${d}` : (c.repayDay || '—'); }
function isRepayOn(c, dateStr) { return getEffectiveRepayDate(c.repayDay) === dateStr; }
function isBillOn(c, dateStr) { const bd = parseBillDay(c.billDay); if (!bd) return false; return parseDate(dateStr).getDate() === bd; }

/* ---------- 数据读取 ---------- */
function getCards() { return all('SELECT * FROM cards ORDER BY id'); }
function getCard(id) { const r = all('SELECT * FROM cards WHERE id=?', [id]); return r[0] || null; }
function getFees(cardId) { return all('SELECT * FROM annual_fees WHERE cardId=? ORDER BY id', [cardId]); }
function getTx(cardId) { return all('SELECT * FROM transactions WHERE cardId=? ORDER BY date DESC, id DESC', [cardId]); }
function allTx() { return all('SELECT * FROM transactions ORDER BY date DESC, id DESC'); }
function getInsts(cardId) { return all('SELECT * FROM installments WHERE cardId=? ORDER BY id', [cardId]); }
function getInst(cardId, id) { const r = all('SELECT * FROM installments WHERE cardId=? AND id=?', [cardId, id]); return r[0] || null; }
function allInsts() { return all('SELECT * FROM installments ORDER BY cardId, id'); }

function sortedCards() {
  const rows = getCards();
  if (sortKey === 'user') return rows.sort((a, b) => String(a.user).localeCompare(String(b.user), 'zh-Hans-CN', { sensitivity: 'base' }) || String(a.tail).localeCompare(String(b.tail)));
  if (sortKey === 'billDay') return rows.sort((a, b) => (parseBillDay(a.billDay) || 99) - (parseBillDay(b.billDay) || 99) || String(a.tail).localeCompare(String(b.tail)));
  if (sortKey === 'repayDay') return rows.sort((a, b) => (getEffectiveRepayDate(a.repayDay) || '9999-12-31').localeCompare(getEffectiveRepayDate(b.repayDay) || '9999-12-31') || String(a.tail).localeCompare(String(b.tail)));
  return rows;
}

/* ---------- 额度反算(同 xyk server) ---------- */
/* 对额度生效的金额:一般等于流水金额;占额度型分期入账时本金早被银行占掉了,
   这里只扣手续费,所以单独存 limitAmount。null 表示按全额扣。 */
function txLimitAmount(tx) {
  if (tx.limitAmount == null || tx.limitAmount === '') return Number(tx.amount || 0);
  const v = Number(tx.limitAmount);
  return Number.isFinite(v) ? v : Number(tx.amount || 0);
}
function applyToAvailable(available, total, tx) {
  const amt = txLimitAmount(tx);
  if (tx.type === 'repayment') return Math.min(total, available + amt);
  return Math.max(0, available - amt);
}
function reverseFromAvailable(available, total, tx) {
  const amt = txLimitAmount(tx);
  if (tx.type === 'repayment') return Math.max(0, available - amt);
  return Math.min(total, available + amt);
}
/* ---------- 数据写入 ---------- */
async function addTransaction(cardId, input) {
  const card = getCard(cardId); if (!card) return;
  const type = input.type === 'repayment' ? 'repayment' : 'spend';
  const feeRate = type === 'repayment' ? null : (Number.isFinite(Number(input.feeRate)) && Number(input.feeRate) >= 0 ? Number(input.feeRate) : DEFAULT_FEE_RATE);
  const tx = { cardId, date: input.date, time: input.time || nowTime(), createdAt: nowStamp(), amount: Number(input.amount || 0), note: input.note || (type === 'repayment' ? '还款' : '消费'), type, feeRate,
    limitAmount: input.limitAmount != null ? Number(input.limitAmount) : null,
    instId: input.instId != null ? Number(input.instId) : null,
    instPeriod: input.instPeriod != null ? Number(input.instPeriod) : null };
  const id = nextId('transactions');
  run(`INSERT INTO transactions(id,cardId,date,time,createdAt,amount,note,type,feeRate,limitAmount,instId,instPeriod) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, tx.cardId, tx.date, tx.time, tx.createdAt, tx.amount, tx.note, tx.type, tx.feeRate, tx.limitAmount, tx.instId, tx.instPeriod]);
  const avail = applyToAvailable(Number(card.available), Number(card.total), tx);
  run('UPDATE cards SET available=? WHERE id=?', [avail, cardId]);
  await persist();
}
async function deleteTransaction(id) {
  const r = all('SELECT * FROM transactions WHERE id=?', [id]); if (!r.length) return;
  const tx = r[0]; const card = getCard(tx.cardId);
  if (card) run('UPDATE cards SET available=? WHERE id=?', [reverseFromAvailable(Number(card.available), Number(card.total), tx), card.id]);
  run('DELETE FROM transactions WHERE id=?', [id]);
  await persist();
}
async function addCard(input) {
  const fixed = Number(input.fixed || 0), temporary = Number(input.temporary || 0);
  const id = nextId('cards');
  run(`INSERT INTO cards(id,user,bank,name,tail,total,fixed,temporary,available,billDay,repayDay) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    [id, input.user || '', input.bank || '', input.name || '', input.tail || '', fixed + temporary, fixed, temporary, Number(input.available != null ? input.available : fixed + temporary), input.billDay || '', input.repayDay || '']);
  await persist(); return id;
}
async function updateCard(id, input) {
  const fixed = Number(input.fixed || 0), temporary = Number(input.temporary || 0);
  run(`UPDATE cards SET user=?,bank=?,name=?,tail=?,total=?,fixed=?,temporary=?,available=?,billDay=?,repayDay=? WHERE id=?`,
    [input.user || '', input.bank || '', input.name || '', input.tail || '', fixed + temporary, fixed, temporary, Number(input.available || 0), input.billDay || '', input.repayDay || '', id]);
  await persist();
}
async function deleteCard(id) {
  run('DELETE FROM transactions WHERE cardId=?', [id]);
  run('DELETE FROM annual_fees WHERE cardId=?', [id]);
  run('DELETE FROM installments WHERE cardId=?', [id]);
  run('DELETE FROM cards WHERE id=?', [id]);
  await persist();
}
async function saveFee(cardId, feeId, input) {
  if (feeId == null) {
    const id = (Number(scalar('SELECT MAX(id) FROM annual_fees WHERE cardId=?', [cardId])) || 0) + 1;
    run(`INSERT INTO annual_fees(id,cardId,name,chargeDate,requirement,status,note) VALUES(?,?,?,?,?,?,?)`,
      [id, cardId, input.name || '年费', input.chargeDate || '未设置', input.requirement || '未设置', input.status || 'pending', input.note || '']);
  } else {
    run(`UPDATE annual_fees SET name=?,chargeDate=?,requirement=?,status=?,note=? WHERE cardId=? AND id=?`,
      [input.name || '年费', input.chargeDate || '未设置', input.requirement || '未设置', input.status || 'pending', input.note || '', cardId, feeId]);
  }
  await persist();
}
async function deleteFee(cardId, feeId) { run('DELETE FROM annual_fees WHERE cardId=? AND id=?', [cardId, feeId]); await persist(); }

/* ---------- 分期 ---------- */
/* 口径:可用额度永远等于银行 APP 显示的数,分期剩余本金不参与任何加减,只做拆解展示。
   两种分期只差 occupyLimit 一位:
     不占额度 — 每期入账扣「本期本金 + 手续费」
     占用额度 — 本金早被银行占掉了,每期入账只扣手续费 */
function money2(n) { return Math.round(Number(n || 0) * 100) / 100; }

/* 等本等息真实年化(IRR,监管披露口径),二分法解月利率再 ×12。
   不入库,每次由本金/期数/每期还款现算,改了金额自动跟着变。 */
function instAnnualRate(principal, periods, perPay) {
  principal = Number(principal); periods = Math.round(Number(periods)); perPay = Number(perPay);
  if (!(principal > 0) || !(periods > 0) || !(perPay > 0)) return null;
  if (perPay * periods <= principal + 1e-9) return 0;   // 总还款不超过本金 = 免息
  const npv = r => { let sum = 0, f = 1; for (let t = 0; t < periods; t++) { f *= (1 + r); sum += perPay / f; } return sum - principal; };
  let lo = 0, hi = 1;
  while (npv(hi) > 0 && hi < 1e4) hi *= 2;
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (npv(m) > 0) lo = m; else hi = m; }
  return (lo + hi) / 2 * 12;
}
function rateBand(rate) { return rate == null ? '' : (rate <= 1e-9 ? 'free' : rate < 0.08 ? 'low' : rate < 0.15 ? 'mid' : 'high'); }
function rateChipHTML(rate) {
  if (rate == null) return '';
  if (rate <= 1e-9) return '<span class="rate-chip free">免息</span>';
  return `<span class="rate-chip ${rateBand(rate)}">真实年化 ${(rate * 100).toFixed(2)}%</span>`;
}

/* 已入账期数取 max(录入时的基线, 已有入账流水的最大期号):
   删掉最后一期流水会自动回退一期可重新补记,删中间某期不会把期号搞乱。 */
function instPosted(n) {
  const periods = Math.max(1, Number(n.periods || 1));
  const base = Math.min(periods, Math.max(0, Number(n.postedBase || 0)));
  const top = Number(scalar('SELECT MAX(instPeriod) FROM transactions WHERE cardId=? AND instId=?', [n.cardId, n.id])) || 0;
  return Math.min(periods, Math.max(base, top));
}
/* 第 k 期入账日:从锚点(startDate = 录入时填的下次入账日)一次性加 (k-锚点期号) 个月,
   逐月累加会在 31 号遇短月后漂移,这样算不会。 */
function instPeriodDate(n, k) {
  if (!n.startDate) return null;
  const anchor = Math.min(Math.max(1, Number(n.periods || 1)), Math.max(0, Number(n.postedBase || 0)) + 1);
  const d = parseDate(n.startDate);
  if (isNaN(d.getTime())) return null;
  return fmtDate(addMonthsClamped(d, k - anchor));
}
function instInfo(n) {
  const periods = Math.max(1, Number(n.periods || 1));
  const principal = Number(n.principal || 0);
  const perFee = money2(n.perFee || 0);
  const perP = Number(n.perPrincipal) > 0 ? money2(n.perPrincipal) : money2(principal / periods);
  const posted = instPosted(n);
  const remain = Math.max(0, periods - posted);
  const closed = n.status === 'closed' || remain <= 0;
  const paidP = Math.min(principal, money2(perP * posted));
  const leftP = money2(Math.max(0, principal - paidP));
  const nextK = posted + 1;
  const nextDate = closed ? null : instPeriodDate(n, nextK);
  const perPay = money2(perP + perFee);
  const rate = instAnnualRate(principal, periods, money2(principal / periods + perFee));
  return {
    periods, principal, perFee, perP, perPay, posted, remain, closed, paidP, leftP, nextK, nextDate, rate,
    feeTotal: money2(perFee * periods),
    pct: Math.min(100, Math.max(0, posted / periods * 100)),
    // 末期本金兜掉除不尽的尾差,保证累计本金恰好等于总本金
    periodPrincipal: k => (k >= periods ? money2(principal - perP * (periods - 1)) : perP)
  };
}
/* 卡片维度汇总:待入账本金 + 占额度型的已占本金 */
function cardInstSummary(cardId) {
  const rows = getInsts(cardId);
  const out = { count: 0, active: 0, pendingP: 0, pendingPay: 0, occupyP: 0, freeP: 0, nextDate: null };
  rows.forEach(n => {
    const i = instInfo(n);
    out.count += 1;
    if (i.closed) return;
    out.active += 1;
    out.pendingP = money2(out.pendingP + i.leftP);
    out.pendingPay = money2(out.pendingPay + i.perPay);
    if (n.occupyLimit) out.occupyP = money2(out.occupyP + i.leftP);
    else out.freeP = money2(out.freeP + i.leftP);
    if (i.nextDate && (!out.nextDate || i.nextDate < out.nextDate)) out.nextDate = i.nextDate;
  });
  return out;
}

async function saveInst(cardId, instId, input) {
  const periods = Math.max(1, Math.round(Number(input.periods || 1)));
  const remaining = Math.min(periods, Math.max(0, Math.round(Number(input.remaining != null ? input.remaining : periods))));
  const principal = Number(input.principal || 0);
  const perPrincipal = Number(input.perPrincipal) > 0 ? Number(input.perPrincipal) : money2(principal / periods);
  const vals = [input.name || '分期', principal, periods, periods - remaining, perPrincipal,
    Number(input.perFee || 0), input.startDate || '', input.occupyLimit ? 1 : 0, input.status || 'active', input.note || ''];
  if (instId == null) {
    const id = (Number(scalar('SELECT MAX(id) FROM installments WHERE cardId=?', [cardId])) || 0) + 1;
    run(`INSERT INTO installments(id,cardId,name,principal,periods,postedBase,perPrincipal,perFee,startDate,occupyLimit,status,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, cardId].concat(vals));
  } else {
    run(`UPDATE installments SET name=?,principal=?,periods=?,postedBase=?,perPrincipal=?,perFee=?,startDate=?,occupyLimit=?,status=?,note=? WHERE cardId=? AND id=?`,
      vals.concat([cardId, instId]));
  }
  await persist();
}
/* 删分期:入账过的流水一并撤掉,额度回滚,避免留下对不上的孤儿流水 */
async function deleteInst(cardId, instId) {
  const txs = all('SELECT * FROM transactions WHERE cardId=? AND instId=?', [cardId, instId]);
  const card = getCard(cardId);
  if (card) {
    let avail = Number(card.available);
    txs.forEach(tx => { avail = reverseFromAvailable(avail, Number(card.total), tx); });
    run('UPDATE cards SET available=? WHERE id=?', [avail, cardId]);
  }
  run('DELETE FROM transactions WHERE cardId=? AND instId=?', [cardId, instId]);
  run('DELETE FROM installments WHERE cardId=? AND id=?', [cardId, instId]);
  await persist();
}
async function closeInst(cardId, instId) {
  run(`UPDATE installments SET status='closed' WHERE cardId=? AND id=?`, [cardId, instId]);
  await persist();
}
async function reopenInst(cardId, instId) {
  run(`UPDATE installments SET status='active' WHERE cardId=? AND id=?`, [cardId, instId]);
  await persist();
}

/* 打开页面时补记:网页没有后台进程,只能在打开时把所有已过入账日的期数一次补齐。
   按 (cardId, instId, instPeriod) 幂等,重复打开不会重复入账。 */
async function catchUpInstallments() {
  const rows = allInsts();
  if (!rows.length) return 0;
  const today = todayStr();
  let done = 0;
  for (const n of rows) {
    if (n.status === 'closed') continue;
    if (!getCard(n.cardId)) continue;
    for (let guard = 0; guard < 240; guard++) {
      const i = instInfo(n);
      if (i.closed || !i.nextDate || i.nextDate > today) break;
      const k = i.nextK;
      const dup = Number(scalar('SELECT COUNT(*) FROM transactions WHERE cardId=? AND instId=? AND instPeriod=?', [n.cardId, n.id, k])) || 0;
      if (dup) break;
      const pp = i.periodPrincipal(k);
      await addTransaction(n.cardId, {
        type: 'spend', date: i.nextDate, time: '00:00', amount: money2(pp + i.perFee),
        note: `${n.name || '分期'} 第 ${k}/${i.periods} 期`, feeRate: 0,
        limitAmount: n.occupyLimit ? i.perFee : null,
        instId: n.id, instPeriod: k
      });
      done += 1;
    }
  }
  return done;
}
/* ---------- 渲染 ---------- */
function feeChip(cardId) { const fs = getFees(cardId); if (!fs.length) return '<span class="fee-chip">无年费规则</span>'; return `<span class="fee-chip">年费 ${fs.length} 条规则</span>`; }
function cardUsed(c) { return Math.max(0, Number(c.total) - Number(c.available)); }
function cardStatus(c) { return Number(c.available) >= Number(c.total) ? '已还清' : '待还款'; }
function cardFeeLines(cardId) {
  const fs = getFees(cardId);
  if (!fs.length) return '<span class="fee-none">无年费规则</span>';
  return fs.map(f => {
    const warn = f.status !== 'done' && f.status !== '已减免' && f.status !== '免';
    return `<span class="fee-line"><span class="fi">¥</span>` +
      `<span class="ft"><b>${esc(f.name || '年费')}</b> · 扣费日 ${esc(f.chargeDate || '未设置')} · ${esc(f.requirement || '未设置')}</span>` +
      `<span class="fs ${warn ? 'warn' : ''}">${esc(f.status || 'pending')}</span></span>`;
  }).join('');
}
function cardItemHTML(c) {
  const used = cardUsed(c), status = cardStatus(c), mark = markColor(c.bank);
  const due = getEffectiveRepayDate(c.repayDay);
  const dueToday = isRepayOn(c, todayStr());
  return `<button class="card-item ${dueToday ? 'due-today' : ''}" onclick="openCard(${c.id})">` +
    `<span class="card-top"><span class="bank-mark ${mark}">${esc(shortName(c.bank))}</span>` +
    `<span class="card-main"><strong class="card-name">${esc(c.bank || c.name || '卡片')}${dueToday ? '<span class="today-badge">今日还款</span>' : ''}</strong>` +
    `<span class="card-sub">${esc(c.user || '')}${c.user ? ' · ' : ''}${esc(c.name || '')} · 尾号 ${esc(c.tail || '----')}</span></span>` +
    `<span class="card-right"><strong class="card-avail">可用 ${yuan(c.available)}</strong>` +
    `<span class="card-amount">已用 ${yuan(used)}</span>` +
    `<span class="card-due ${dueToday ? 'today' : (status === '已还清' ? 'ok' : '')}">${due ? '还款 ' + due : esc(c.repayDay || '')} · ${status}</span>` +
    `${c.billDay ? `<span class="card-bill">账单 ${esc(c.billDay)}</span>` : ''}</span>` +
    `<span class="chevron">›</span></span>` +
    `<span class="card-fees">${cardFeeLines(c.id)}</span></button>`;
}
function renderHome() {
  const cs = sortedCards();
  const t = cs.reduce((a, c) => { a.total += +c.total; a.fixed += +c.fixed; a.temp += +c.temporary; a.avail += +c.available; return a; }, { total: 0, fixed: 0, temp: 0, avail: 0 });
  const used = Math.max(0, t.total - t.avail), pct = t.total ? Math.min(100, used / t.total * 100) : 0;
  document.getElementById('heroTotal').innerHTML = `${yuan(t.total)}<span class="hero-unit">总额度</span>`;
  document.getElementById('heroBar').style.width = pct + '%';
  document.getElementById('heroUsed').textContent = '已用 ' + yuan(used);
  document.getElementById('heroPct').textContent = pct.toFixed(1) + '%';
  document.getElementById('heroFixed').textContent = yuan(t.fixed);
  document.getElementById('heroTemp').textContent = yuan(t.temp);
  document.getElementById('heroAvail').textContent = yuan(t.avail);
  document.getElementById('homeCards').innerHTML = cs.length ? cs.map(cardItemHTML).join('') : '<div class="flow-empty">还没有卡片,去设置里添加</div>';
}
function renderCards() {
  const el = document.getElementById('allCards');
  if (!el) return;
  const cs = sortedCards();
  const cnt = document.getElementById('cardsCount'); if (cnt) cnt.textContent = cs.length + ' 张卡片';
  el.innerHTML = cs.length ? cs.map(cardItemHTML).join('') : '<div class="flow-empty">还没有卡片</div>';
}
function flowItemHTML(tx, tap) {
  const card = getCard(tx.cardId) || {};
  const isPay = tx.type === 'repayment';
  const k = isPay ? 'pay' : 'out';
  const amt = (isPay ? 1 : -1) * Number(tx.amount || 0);
  const settle = isPay ? '' : ` · 到账 ${yuan(Number(tx.amount || 0) - getFeeAmount(tx))}`;
  return `<div class="flow-item ${tap ? 'tap' : ''}" ${tap ? `onclick="confirmDelTx(${tx.id})"` : ''}>` +
    `<span class="flow-ic ${k}">${isPay ? '↓' : '↑'}</span>` +
    `<span class="flow-main"><span class="flow-title">${esc(tx.note || (isPay ? '还款' : '消费'))}</span>` +
    `<span class="flow-meta">${esc(shortName(card.bank))}${esc(card.tail || '')} · ${esc(tx.date)}${tx.time ? ' ' + esc(tx.time) : ''}${settle}</span></span>` +
    `<span class="flow-amt ${k}">${signed(amt)}</span></div>`;
}
function renderRepayment() {
  const cs = getCards();
  const base = parseDate(selectedDate);
  document.getElementById('calMonthLabel').textContent = `${base.getFullYear()} 年 ${base.getMonth() + 1} 月`;
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  let html = '';
  for (let off = -3; off <= 3; off++) {
    const d = new Date(base); d.setDate(base.getDate() + off);
    const ds = fmtDate(d);
    const isDue = cs.some(c => isRepayOn(c, ds));
    const isBill = cs.some(c => isBillOn(c, ds));
    const cls = [ds === selectedDate ? 'selected-day' : '', ds === todayStr() ? 'today' : '', isDue ? 'due-day' : '', isBill ? 'bill-day' : ''].filter(Boolean).join(' ');
    const lbl = ds === todayStr() ? '今天' : week[d.getDay()];
    html += `<span class="${cls}" onclick="selDay('${ds}')"><small>${lbl}</small>${d.getDate()}${(isDue || isBill) ? '<i></i>' : ''}</span>`;
  }
  document.getElementById('calStrip').innerHTML = html;
  const d = parseDate(selectedDate);
  document.getElementById('flowDay').textContent = `${d.getMonth() + 1}月${d.getDate()}日`;
  const flows = allTx().filter(t => t.date === selectedDate);
  document.getElementById('dayFlow').innerHTML = flows.length ? flows.map(t => flowItemHTML(t, true)).join('') : '<div class="flow-empty">当日暂无流水记录</div>';
}
function renderAll() { renderHome(); renderCards(); renderRepayment(); }
function go(p) {
  document.querySelectorAll('.page').forEach(x => x.classList.toggle('active', x.dataset.page === p));
  document.querySelectorAll('.nav-item').forEach((n, i) => n.classList.toggle('active', ['home', 'repayment', 'settings'][i] === p));
  document.getElementById('pageTitle').textContent = titles[p];
  if (p === 'repayment') renderRepayment();
  window.scrollTo(0, 0);
}
function selDay(ds) { selectedDate = ds; renderRepayment(); }
function toToday() { selectedDate = todayStr(); renderRepayment(); }
/* ---------- 弹层通用 ---------- */
function show() { document.getElementById('mb').classList.add('show'); }
function closeM() { document.getElementById('mb').classList.remove('show'); }
function setModal(title, html) { document.getElementById('mTitle').textContent = title; document.getElementById('mBody').innerHTML = html; show(); }
function val(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }

/* ---------- 卡片详情 ---------- */
function openCard(id) {
  const c = getCard(id); if (!c) return;
  const used = cardUsed(c), pct = c.total ? Math.min(100, used / c.total * 100) : 0;
  const fees = getFees(id), tx = getTx(id).slice(0, 8);
  const feeState = fees.length ? `${fees.length} 条规则` : '未设置';
  setModal('卡片详情',
    `<div class="detail-hero"><span class="bank-mark ${markColor(c.bank)}">${esc(shortName(c.bank))}</span><div><strong>${esc(c.bank || c.name)}</strong><span>${esc(c.name || '')} · 尾号 ${esc(c.tail || '----')}${c.user ? ' · ' + esc(c.user) : ''}</span></div></div>` +
    `<div class="detail-amount">${yuan(used)}</div><div class="detail-caption">当前已用额度</div>` +
    `<div class="detail-progress"><span style="width:${pct}%"></span></div>` +
    `<div class="detail-grid"><div class="detail-cell"><span>总额度</span><strong>${yuan(c.total)}</strong></div><div class="detail-cell"><span>可用额度</span><strong>${yuan(c.available)}</strong></div>` +
    `<div class="detail-cell"><span>固定 / 临时</span><strong>${yuan(c.fixed)} / ${yuan(c.temporary)}</strong></div><div class="detail-cell"><span>账单日</span><strong>${esc(c.billDay || '—')}</strong></div></div>` +
    limitSplitHTML(c) +
    instEntryHTML(id) +
    `<div class="annual-fee" onclick="openFees(${id})"><span class="af-icon">¥</span><span class="af-body"><span class="af-title">年费 · ${feeState}</span><span class="af-sub">点击查看/管理年费规则 ›</span></span><span class="af-state">${fees.length ? '查看' : '添加'}</span></div>` +
    `<div class="detail-row"><span>还款日</span><strong>${esc(getEffectiveRepayDay(c))}</strong></div>` +
    `<div class="detail-row"><span>状态</span><strong>${cardStatus(c)}</strong></div>` +
    `<div class="flow-head" style="margin-top:16px"><h3>最近流水</h3></div>` +
    `<div class="flow-list">${tx.length ? tx.map(t => flowItemHTML(t, true)).join('') : '<div class="flow-empty">暂无流水,点下方记一笔</div>'}</div>` +
    `<div class="flow-cta"><button class="rec" onclick="openRecord(${id})">＋ 记一笔流水</button><button class="edit" onclick="openEdit(${id})">编辑卡片</button></div>`);
}

/* ---------- 记一笔流水 ---------- */
function updateSettle() {
  const on = document.querySelector('.type-seg button.on').dataset.t;
  const box = document.getElementById('settleBox');
  if (on !== 'spend') { box.classList.add('hide'); return; }
  box.classList.remove('hide');
  const v = parseFloat(val('recAmt')) || 0, fee = v * DEFAULT_FEE_RATE;
  document.getElementById('recFee').textContent = yuan(+fee.toFixed(2));
  document.getElementById('recSettle').textContent = yuan(+(v - fee).toFixed(2));
}
function openRecord(id) {
  const c = getCard(id); if (!c) return;
  setModal('记一笔流水',
    `<p class="muted" style="margin:-6px 0 10px">${esc(c.bank || c.name)} · 尾号 ${esc(c.tail || '----')}</p>` +
    `<div class="type-seg"><button class="on" data-t="spend">消费(支出)</button><button data-t="repayment">还款</button></div>` +
    `<label class="field-label">金额</label><input id="recAmt" class="big-amount-input" inputmode="decimal" placeholder="0.00" oninput="updateSettle()">` +
    `<div class="settle-line" id="settleBox"><span>手续费率 0.25% · 手续费 <b id="recFee">¥0</b></span><span>到账 <strong id="recSettle">¥0</strong></span></div>` +
    `<label class="field-label">日期</label><input id="recDate" class="modal-input" type="date" value="${todayStr()}">` +
    `<label class="field-label">备注</label><input id="recNote" class="modal-input" placeholder="例如 超市消费">` +
    `<button class="primary-action" onclick="saveRecord(${id})">保存流水</button>`);
  document.querySelectorAll('.type-seg button').forEach(b => b.onclick = () => { document.querySelectorAll('.type-seg button').forEach(x => x.classList.remove('on')); b.classList.add('on'); updateSettle(); });
  updateSettle();
}
async function saveRecord(id) {
  const type = document.querySelector('.type-seg button.on').dataset.t;
  const amount = parseFloat(val('recAmt')) || 0;
  if (amount <= 0) { toast('请输入金额'); return; }
  await addTransaction(id, { type, amount, date: val('recDate') || todayStr(), note: val('recNote') });
  renderAll(); openCard(id); toast('已记录');
}
function confirmDelTx(id) {
  if (window.confirm('删除这笔流水?额度会自动反算恢复。')) {
    const tx = all('SELECT cardId FROM transactions WHERE id=?', [id]);
    const cardId = tx.length ? tx[0].cardId : null;
    deleteTransaction(id).then(() => { renderAll(); if (cardId && document.getElementById('mb').classList.contains('show')) openCard(cardId); else closeM(); toast('已删除'); });
  }
}
/* ---------- 年费规则 ---------- */
function openFees(id) {
  const c = getCard(id); if (!c) return;
  const fees = getFees(id);
  const rules = fees.length ? fees.map(f => {
    const warn = f.status !== 'done' && f.status !== '已减免' && f.status !== '免';
    return `<div class="af-rule"><span class="af-r-ic">¥</span><span class="af-r-body"><span class="af-r-title">${esc(f.name || '年费')}</span>` +
      `<span class="af-r-sub">扣费日 ${esc(f.chargeDate || '未设置')} · ${esc(f.requirement || '未设置')}${f.note ? ' · ' + esc(f.note) : ''}</span></span>` +
      `<span class="af-r-state ${warn ? 'warn' : ''}" onclick="openEditRule(${id},${f.id})">${esc(f.status || 'pending')}</span></div>`;
  }).join('') : '<div class="flow-empty">该卡未设置年费规则</div>';
  setModal('年费规则', `<p class="muted" style="margin:-6px 0 12px">${esc(c.bank || c.name)} · 尾号 ${esc(c.tail || '----')} — 可设多条规则,点状态标签可编辑</p>${rules}<button class="add-rule" onclick="openAddRule(${id})">＋ 新增年费规则</button>`);
}
function ruleForm(id, f) {
  return `<label class="field-label">规则名称</label><input id="fName" class="modal-input" value="${esc(f ? f.name : '年费')}" placeholder="例如 主卡年费">` +
    `<label class="field-label">扣费日期</label><input id="fDate" class="modal-input" value="${esc(f ? f.chargeDate : '')}" placeholder="MM-DD,例如 12-01 / 未设置">` +
    `<label class="field-label">减免条件</label><input id="fReq" class="modal-input" value="${esc(f ? f.requirement : '')}" placeholder="例如 年刷满6笔免 / 固定收取">` +
    `<label class="field-label">状态</label><input id="fStatus" class="modal-input" value="${esc(f ? f.status : 'pending')}" placeholder="pending / 已减免 / 已缴">` +
    `<label class="field-label">备注</label><input id="fNote" class="modal-input" value="${esc(f ? f.note : '')}" placeholder="选填">`;
}
function readRule() { return { name: val('fName'), chargeDate: val('fDate') || '未设置', requirement: val('fReq') || '未设置', status: val('fStatus') || 'pending', note: val('fNote') }; }
function openAddRule(id) { setModal('新增年费规则', `<p class="muted" style="margin:-6px 0 10px">为该卡新增一条年费规则</p>${ruleForm(id, null)}<button class="primary-action" onclick="saveRule(${id},null)">保存规则</button>`); }
function openEditRule(id, feeId) {
  const f = getFees(id).find(x => x.id === feeId);
  setModal('编辑年费规则', ruleForm(id, f) + `<button class="primary-action" onclick="saveRule(${id},${feeId})">保存修改</button><button class="secondary-action" onclick="removeRule(${id},${feeId})">删除该规则</button>`);
}
async function saveRule(id, feeId) { await saveFee(id, feeId, readRule()); openFees(id); toast('已保存'); }
async function removeRule(id, feeId) { if (window.confirm('删除该年费规则?')) { await deleteFee(id, feeId); openFees(id); toast('已删除'); } }

/* ---------- 分期 UI ---------- */
/* 卡片详情里的额度拆解:可用额度就是银行 APP 那个数,这里只解释它为什么是这个数 */
function limitSplitHTML(c) {
  const sum = cardInstSummary(c.id);
  if (!sum.active) return '';
  const lines = [];
  if (sum.freeP > 0) lines.push(`<div class="ls-line"><span>分期待入账本金 · 不占额度</span><b>${yuan(sum.freeP)}</b></div>`);
  if (sum.occupyP > 0) lines.push(`<div class="ls-line occupy"><span>分期剩余本金 · 已占额度</span><b>${yuan(sum.occupyP)}</b></div>`);
  if (sum.nextDate) lines.push(`<div class="ls-line"><span>下次入账 ${esc(sum.nextDate)}</span><b>${yuan(sum.pendingPay)} × ${sum.active} 笔</b></div>`);
  return `<div class="limit-split">` +
    `<div class="ls-top"><span class="ls-label">可用额度<span class="ls-bank">与银行 APP 一致</span></span><span class="ls-value">${yuan(c.available)}</span></div>` +
    lines.join('') + `</div>`;
}
function instEntryHTML(id) {
  const sum = cardInstSummary(id);
  const state = sum.count ? (sum.active ? `${sum.active} 笔进行中` : `${sum.count} 笔已结清`) : '未设置';
  const sub = sum.active
    ? `下次入账 ${esc(sum.nextDate || '未设置')} 共 ${yuan(sum.pendingPay)} · 待入账本金 ${yuan(sum.pendingP)} ›`
    : '点击添加分期，到入账日自动记账 ›';
  return `<div class="inst-entry" onclick="openInsts(${id})"><span class="ie-icon">分</span><span class="ie-body"><span class="ie-title">分期 · ${esc(state)}</span><span class="ie-sub">${sub}</span></span><span class="ie-state">${sum.count ? '查看' : '添加'}</span></div>`;
}
function instRowHTML(cardId, n) {
  const i = instInfo(n);
  const tag = i.closed ? '<span class="inst-tag done">已结清</span>'
    : (n.occupyLimit ? '<span class="inst-tag occupy">占用额度</span>' : '<span class="inst-tag">不占额度</span>');
  const sub = i.closed ? `本金 ${yuan(i.principal)} · 共 ${i.periods} 期`
    : `每期 ${yuan(i.perP)} + 手续费 ${yuan(i.perFee)}`;
  const foot = i.closed ? `本金 ${yuan(i.principal)} · 累计手续费 ${yuan(i.feeTotal)}`
    : `下次入账 ${esc(i.nextDate || '未设置')} · 剩余本金 ${yuan(i.leftP)}`;
  return `<div class="inst-row${i.closed ? ' settled' : ''}" onclick="openEditInst(${cardId},${n.id})">` +
    `<div class="ir-top"><span class="ir-ic">${i.closed ? '✓' : '分'}</span>` +
    `<span class="ir-body"><span class="ir-title">${esc(n.name || '分期')} ${Number(i.principal).toLocaleString('zh-CN')}${tag}</span><span class="ir-sub">${sub}</span></span>` +
    `<span class="ir-amt"><span class="ir-per">${yuan(i.perPay)}</span><span class="ir-left">${i.closed ? '' : '剩 '}${i.remain || i.periods} / ${i.periods} 期</span></span></div>` +
    `<div class="inst-bar"><span style="width:${i.pct}%"></span></div>` +
    `<div class="inst-foot"><span>${foot}</span>${rateChipHTML(i.rate)}</div></div>`;
}
function openInsts(id) {
  const c = getCard(id); if (!c) return;
  const rows = getInsts(id);
  const list = rows.length ? rows.map(n => instRowHTML(id, n)).join('') : '<div class="flow-empty">该卡未设置分期</div>';
  setModal('分期',
    (lastCatchUp ? `<div class="autopost"><span class="ap-ic">✓</span><span class="ap-tx">本次打开自动补记了 ${lastCatchUp} 期分期入账，已从对应卡片的可用额度中扣减。</span></div>` : '') +
    `<p class="muted" style="margin:-6px 0 12px">${esc(c.bank || c.name)} · 尾号 ${esc(c.tail || '----')} — 点任意一笔可编辑；到入账日打开网页会自动记账</p>` +
    list +
    (rows.length ? `<div class="rate-legend"><em>档位</em><span class="rate-chip free">免息</span><span class="rate-chip low">&lt; 8%</span><span class="rate-chip mid">8 ~ 15%</span><span class="rate-chip high">≥ 15%</span></div>` : '') +
    `<button class="add-rule" onclick="openAddInst(${id})">＋ 新增分期</button>`);
}
/* 表单:边填边算真实年化,金额一改预览就跟着变 */
function updateInstPreview() {
  const box = document.getElementById('instPrev'); if (!box) return;
  const principal = parseFloat(val('iPrincipal')) || 0;
  const periods = Math.max(1, Math.round(parseFloat(val('iPeriods')) || 0) || 1);
  const perFee = parseFloat(val('iFee')) || 0;
  const perP = parseFloat(val('iPerP')) > 0 ? parseFloat(val('iPerP')) : (principal ? money2(principal / periods) : 0);
  const perPay = money2(perP + perFee);
  const rate = instAnnualRate(principal, periods, perPay);
  const monthly = principal > 0 ? perFee / principal : 0;
  document.getElementById('iPerHint').textContent = perP ? `每期本金 ${yuan(perP)}，每期共还 ${yuan(perPay)}` : '填入总本金和期数后自动计算';
  box.innerHTML = principal > 0 && perPay > 0
    ? `<span>月费率 ${(monthly * 100).toFixed(3)}% · 名义年化 ${(monthly * 12 * 100).toFixed(2)}%</span>${rateChipHTML(rate)}`
    : `<span>填入金额后显示真实年化</span>`;
}
function instForm(n) {
  const occupy = n ? Number(n.occupyLimit) : 0;
  const i = n ? instInfo(n) : null;
  return `<div class="type-seg" id="iSeg"><button class="${occupy ? '' : 'on'}" data-o="0">不占额度</button><button class="${occupy ? 'on' : ''}" data-o="1">占用额度</button></div>` +
    `<p class="muted" style="margin:8px 0 2px;font-size:11px">不占额度：每期扣「本金＋手续费」。占用额度：本金已被银行扣掉，每期只扣手续费。可用额度始终照抄银行 APP。</p>` +
    `<label class="field-label">分期名称</label><input id="iName" class="modal-input" value="${esc(n ? n.name : '')}" placeholder="例如 消费分期 / 账单分期">` +
    `<label class="field-label">总本金</label><input id="iPrincipal" class="modal-input" inputmode="decimal" value="${n ? Number(n.principal) : ''}" placeholder="例如 48000" oninput="updateInstPreview()">` +
    `<label class="field-label">总期数 / 剩余期数</label><div class="query-bar"><input id="iPeriods" class="modal-input" inputmode="numeric" value="${n ? Number(n.periods) : ''}" placeholder="12" oninput="updateInstPreview()"><input id="iRemain" class="modal-input" inputmode="numeric" value="${i ? i.remain : ''}" placeholder="剩余 12"></div>` +
    `<label class="field-label">每期本金（留空按总本金÷期数）</label><input id="iPerP" class="modal-input" inputmode="decimal" value="${n && Number(n.perPrincipal) ? Number(n.perPrincipal) : ''}" placeholder="自动计算" oninput="updateInstPreview()">` +
    `<label class="field-label">每期手续费</label><input id="iFee" class="modal-input" inputmode="decimal" value="${n ? Number(n.perFee) : ''}" placeholder="例如 66.53" oninput="updateInstPreview()">` +
    `<div class="settle-line" id="instPrev"><span>填入金额后显示真实年化</span></div>` +
    `<p class="muted" id="iPerHint" style="margin:6px 0 0;font-size:11px">填入总本金和期数后自动计算</p>` +
    `<label class="field-label">下次入账日</label><input id="iStart" class="modal-input" type="date" value="${esc(n ? n.startDate : '')}">` +
    `<label class="field-label">备注</label><input id="iNote" class="modal-input" value="${esc(n ? n.note : '')}" placeholder="选填">`;
}
function bindInstForm() {
  document.querySelectorAll('#iSeg button').forEach(b => b.onclick = () => {
    document.querySelectorAll('#iSeg button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
  });
  updateInstPreview();
}
function readInstForm() {
  const seg = document.querySelector('#iSeg button.on');
  return {
    name: val('iName') || '分期', principal: parseFloat(val('iPrincipal')) || 0,
    periods: parseFloat(val('iPeriods')) || 0, remaining: val('iRemain') === '' ? null : parseFloat(val('iRemain')),
    perPrincipal: parseFloat(val('iPerP')) || 0, perFee: parseFloat(val('iFee')) || 0,
    startDate: val('iStart'), occupyLimit: seg ? seg.dataset.o === '1' : false, note: val('iNote')
  };
}
function openAddInst(id) {
  setModal('新增分期', `<p class="muted" style="margin:-6px 0 10px">填入剩余期数，之后每到入账日打开网页会自动补记</p>${instForm(null)}<button class="primary-action" onclick="saveInstForm(${id},null)">保存分期</button>`);
  bindInstForm();
}
function openEditInst(id, instId) {
  const n = getInst(id, instId); if (!n) return;
  const i = instInfo(n);
  setModal('编辑分期', instForm(n) +
    `<p class="muted" style="margin:12px 0 0;font-size:11px">已入账 ${i.posted} / ${i.periods} 期。改剩余期数会重设已入账基线，已生成的入账流水不会被删。</p>` +
    `<button class="primary-action" onclick="saveInstForm(${id},${instId})">保存修改</button>` +
    (n.status === 'closed'
      ? `<button class="secondary-action" style="border-color:#cfe0ff;background:#f4f8ff;color:var(--blue)" onclick="reopenInstUI(${id},${instId})">恢复为进行中</button>`
      : `<button class="secondary-action" style="border-color:#cfe0ff;background:#f4f8ff;color:var(--blue)" onclick="closeInstUI(${id},${instId})">标记已结清（停止入账）</button>`) +
    `<button class="secondary-action" onclick="removeInst(${id},${instId})">删除该分期</button>`);
  bindInstForm();
}
async function saveInstForm(id, instId) {
  const input = readInstForm();
  if (!(input.principal > 0)) { toast('请输入总本金'); return; }
  if (!(input.periods >= 1)) { toast('请输入总期数'); return; }
  if (!input.startDate) { toast('请选择下次入账日'); return; }
  if (input.remaining == null) input.remaining = input.periods;
  const old = instId != null ? getInst(id, instId) : null;
  if (old) input.status = old.status;
  await saveInst(id, instId, input);
  const n = await catchUpInstallments();   // 若入账日已过,存完立刻补记
  renderAll(); openInsts(id); toast(n ? `已保存,自动入账 ${n} 期` : '已保存');
}
async function removeInst(id, instId) {
  if (!window.confirm('删除该分期?已自动生成的入账流水会一并撤销,额度自动恢复。')) return;
  await deleteInst(id, instId); renderAll(); openInsts(id); toast('已删除');
}
async function closeInstUI(id, instId) { await closeInst(id, instId); renderAll(); openInsts(id); toast('已标记结清'); }
async function reopenInstUI(id, instId) { await reopenInst(id, instId); renderAll(); openInsts(id); toast('已恢复'); }

/* ---------- 流水查询 ---------- */
function openQuery() {
  const cs = getCards();
  setModal('流水查询',
    `<label class="field-label">选择卡号</label><select id="qCard" class="modal-input" onchange="runQuery()"><option value="">全部卡片</option>${cs.map(c => `<option value="${c.id}">${esc(c.bank || c.name)} · 尾号 ${esc(c.tail || '----')}</option>`).join('')}</select>` +
    `<label class="field-label">日期范围</label><div class="query-bar"><input id="qFrom" class="modal-input" type="date" onchange="runQuery()"><input id="qTo" class="modal-input" type="date" onchange="runQuery()"></div>` +
    `<div class="query-sum"><div><span>支出合计</span><strong class="out" id="qOut">¥0</strong></div><div><span>还款合计</span><strong class="pay" id="qPay">¥0</strong></div></div>` +
    `<div class="flow-head"><h3>结果</h3><span class="flow-day" id="qCount">0 笔</span></div><div class="flow-list" id="qList"></div>`);
  runQuery();
}
function runQuery() {
  const cardSel = val('qCard'), f = val('qFrom'), t = val('qTo');
  let out = 0, pay = 0;
  const rows = allTx().filter(x => {
    if (cardSel && String(x.cardId) !== cardSel) return false;
    if (f && x.date < f) return false;
    if (t && x.date > t) return false;
    return true;
  });
  rows.forEach(x => { if (x.type === 'repayment') pay += Number(x.amount); else out += Number(x.amount); });
  document.getElementById('qOut').textContent = yuan(out);
  document.getElementById('qPay').textContent = yuan(pay);
  document.getElementById('qCount').textContent = rows.length + ' 笔';
  document.getElementById('qList').innerHTML = rows.length ? rows.map(x => flowItemHTML(x, false)).join('') : '<div class="flow-empty">没有匹配的流水</div>';
}

/* ---------- 排序 ---------- */
function openSort() {
  const opts = [['user', '用户拼音'], ['billDay', '账单日'], ['repayDay', '还款日']];
  setModal('卡片排序', opts.map(([k, label]) => `<button class="sort-row ${k === sortKey ? 'on' : ''}" onclick="setSort('${k}','${label}')">${label}<span class="tick">${k === sortKey ? '✓' : ''}</span></button>`).join(''));
}
function setSort(k, label) { sortKey = k; const s = document.getElementById('sortName'); if (s) s.textContent = label; renderHome(); renderCards(); closeM(); }
/* ---------- 卡片增删改 ---------- */
function cardForm(c) {
  const billDay = c ? (parseBillDay(c.billDay) || '') : '';
  const mode = c ? getRepayMode(c.repayDay) : '固定';
  const repayDate = c ? (parseRepayDate(c.repayDay) || '') : '';
  return `<label class="field-label">持卡人</label><input id="cUser" class="modal-input" value="${esc(c ? c.user : '')}" placeholder="例如 本人 / 家人">` +
    `<label class="field-label">发卡银行</label><input id="cBank" class="modal-input" value="${esc(c ? c.bank : '')}" placeholder="例如 招商银行">` +
    `<label class="field-label">卡种名称</label><input id="cName" class="modal-input" value="${esc(c ? c.name : '')}" placeholder="例如 经典白金卡">` +
    `<label class="field-label">卡号后四位</label><input id="cTail" class="modal-input" inputmode="numeric" maxlength="4" value="${esc(c ? c.tail : '')}" placeholder="8019">` +
    `<label class="field-label">固定额度</label><input id="cFixed" class="modal-input" inputmode="decimal" value="${c ? c.fixed : ''}" placeholder="50000">` +
    `<label class="field-label">临时额度</label><input id="cTemp" class="modal-input" inputmode="decimal" value="${c ? c.temporary : '0'}" placeholder="0">` +
    (c ? `<label class="field-label">可用额度</label><input id="cAvail" class="modal-input" inputmode="decimal" value="${c.available}">` : '') +
    `<label class="field-label">账单日(每月几号)</label><input id="cBill" class="modal-input" inputmode="numeric" value="${billDay}" placeholder="1">` +
    `<label class="field-label">还款方式</label><select id="cMode" class="modal-input"><option ${mode === '固定' ? 'selected' : ''}>固定</option><option ${mode === '顺延' ? 'selected' : ''}>顺延</option></select>` +
    `<label class="field-label">还款日</label><input id="cRepay" class="modal-input" type="date" value="${repayDate}">`;
}
function readCardForm(isEdit) {
  const billNum = parseInt(val('cBill'), 10);
  const repay = val('cRepay');
  const o = {
    user: val('cUser'), bank: val('cBank'), name: val('cName'), tail: val('cTail'),
    fixed: Number(val('cFixed') || 0), temporary: Number(val('cTemp') || 0),
    billDay: billNum ? `每月${billNum}号` : '',
    repayDay: repay ? `${val('cMode') || '固定'}：${repay}` : ''
  };
  if (isEdit) o.available = Number(val('cAvail') || 0);
  return o;
}
function openAdd() { setModal('添加新卡片', cardForm(null) + `<button class="primary-action" onclick="saveNewCard()">保存卡片</button>`); }
async function saveNewCard() {
  const o = readCardForm(false);
  if (!o.bank && !o.name) { toast('请填写银行或卡种'); return; }
  o.available = o.fixed + o.temporary;
  const id = await addCard(o); renderAll(); openCard(id); toast('已添加');
}
function openEdit(id) {
  const c = getCard(id); if (!c) return;
  setModal('修改卡片信息', `<p class="muted" style="margin:-6px 0 10px">${esc(c.bank || c.name)} · 尾号 ${esc(c.tail || '----')}</p>` + cardForm(c) +
    `<button class="primary-action" onclick="saveEditCard(${id})">保存修改</button><button class="secondary-action" onclick="confirmDelCard(${id})">删除这张卡片</button>`);
}
async function saveEditCard(id) { await updateCard(id, readCardForm(true)); renderAll(); openCard(id); toast('已保存'); }
function openEditPick() {
  const cs = getCards();
  setModal('修改卡片', '<p class="muted" style="margin:-6px 0 10px">选择要修改的卡片。</p>' + (cs.length ? cs.map(c => `<div class="pick-row" onclick="openEdit(${c.id})" style="cursor:pointer"><span class="bank-mark ${markColor(c.bank)}" style="width:32px;height:32px;font-size:11px">${esc(shortName(c.bank))}</span><span><strong style="font-size:13px">${esc(c.bank || c.name)}</strong><br><span class="muted">尾号 ${esc(c.tail || '----')}</span></span><span class="chevron" style="margin-left:auto">›</span></div>`).join('') : '<div class="flow-empty">还没有卡片</div>'));
}
function openManage() {
  const cs = getCards();
  setModal('删除卡片', '<p class="muted" style="margin:-6px 0 10px">删除后该卡片及其流水、年费将一并移除,操作不可撤销。</p>' + (cs.length ? cs.map(c => `<div class="pick-row"><span class="bank-mark ${markColor(c.bank)}" style="width:32px;height:32px;font-size:11px">${esc(shortName(c.bank))}</span><span><strong style="font-size:13px">${esc(c.bank || c.name)}</strong><br><span class="muted">尾号 ${esc(c.tail || '----')}</span></span><button class="pick-del" onclick="confirmDelCard(${c.id})">删除</button></div>`).join('') : '<div class="flow-empty">还没有卡片</div>'));
}
function confirmDelCard(id) {
  const c = getCard(id); if (!c) return;
  if (window.confirm(`删除「${c.bank || c.name} 尾号${c.tail}」及其全部流水/年费?`)) {
    deleteCard(id).then(() => { renderAll(); openManage(); toast('已删除'); });
  }
}
/* ---------- 登录 / 本地密码 ---------- */
async function sha(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
async function ensureDefaultPass() { if (!localStorage.getItem(PASS_KEY)) localStorage.setItem(PASS_KEY, await sha(DEFAULT_PASS)); }
async function tryLogin() {
  const input = document.getElementById('authInput').value;
  const err = document.getElementById('authErr');
  if (!input) { err.textContent = '请输入密码'; return; }
  const ok = (await sha(input)) === localStorage.getItem(PASS_KEY);
  if (!ok) { err.textContent = '密码不正确'; return; }
  err.textContent = '';
  document.getElementById('authInput').value = '';
  showApp();
}
function showApp() {
  document.getElementById('authScreen').classList.remove('show');
  document.getElementById('appShell').style.display = '';
  document.querySelector('.bottom-nav').style.display = '';
  window.scrollTo(0, 0);
  unlocked = true;
  // 输入密码后:不管本地是否有数据,都自动从 GitHub 拉取最新数据
  syncOnOpen();
}
function lockApp() {
  closeM();
  unlocked = false;
  document.getElementById('authScreen').classList.add('show');
  document.getElementById('appShell').style.display = 'none';
  document.querySelector('.bottom-nav').style.display = 'none';
  window.scrollTo(0, 0);
}
function openPwd() {
  setModal('修改密码', `<p class="muted" style="margin:-6px 0 10px">修改打开 App 的本地密码(仅存本机,用于遮挡,非服务器级鉴权)。</p>` +
    `<label class="field-label">当前密码</label><input id="p0" class="modal-input" type="password" placeholder="输入当前密码">` +
    `<label class="field-label">新密码</label><input id="p1" class="modal-input" type="password" placeholder="至少 4 位">` +
    `<label class="field-label">确认新密码</label><input id="p2" class="modal-input" type="password" placeholder="再次输入">` +
    `<button class="primary-action" onclick="savePwd()">保存新密码</button>`);
}
async function savePwd() {
  const cur = document.getElementById('p0').value, n1 = document.getElementById('p1').value, n2 = document.getElementById('p2').value;
  if ((await sha(cur)) !== localStorage.getItem(PASS_KEY)) { toast('当前密码不正确'); return; }
  if (n1.length < 4) { toast('新密码至少 4 位'); return; }
  if (n1 !== n2) { toast('两次输入不一致'); return; }
  localStorage.setItem(PASS_KEY, await sha(n1)); closeM(); toast('密码已修改');
}
/* ---------- 备份与同步(GitHub 私有仓库) ---------- */
function ghCfg() { try { return JSON.parse(localStorage.getItem(GH_KEY) || '{}'); } catch (e) { return {}; } }
function ghReady(cfg = ghCfg()) { return Boolean(cfg.user && cfg.repo && cfg.token); }
function bytesToB64(bytes) { let bin = ''; const chunk = 0x8000; for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)); return btoa(bin); }
function b64ToBytes(b64) { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
function updateSyncLabel() {
  const el = document.getElementById('syncTime'); if (!el) return;
  const last = localStorage.getItem(SYNC_TIME_KEY);
  el.textContent = dirty ? '本地有改动 · 待同步' : (last ? '上次同步 ' + last : '未同步');
}
function dbSizeText() { try { return Math.round(db.export().byteLength / 1024) + ' KB'; } catch (e) { return '—'; } }
function dbCounts() {
  try {
    const count = table => Number(scalar(`SELECT COUNT(*) FROM ${table}`)) || 0;
    return { cards: count('cards'), transactions: count('transactions'), annualFees: count('annual_fees'), installments: count('installments') };
  } catch (e) {
    return { cards: 0, transactions: 0, annualFees: 0, installments: 0 };
  }
}
function isDbEmpty() { const c = dbCounts(); return !c.cards && !c.transactions && !c.annualFees && !c.installments; }
function dbSummary() {
  const c = dbCounts();
  return `${c.cards} 张卡片、${c.transactions} 条流水、${c.annualFees} 条年费记录、${c.installments} 条分期`;
}
function openSync() {
  const cfg = ghCfg();
  const connected = ghReady(cfg);
  const info = connected ? `${esc(cfg.user)} / ${esc(cfg.repo)}` : '尚未配置备份仓库';
  setModal('备份与同步',
    `<p class="muted" style="margin:-6px 0 12px">已启用自动同步：输入密码进入后自动拉取云端数据并与本机对比，若有差异会让你选择用本机还是云端；新增、修改或删除后自动备份到 GitHub 私有仓库。</p>` +
    `<div class="af-rule"><span class="af-r-ic" style="background:var(--green-soft);color:var(--green)">☁</span><span class="af-r-body"><span class="af-r-title">${info}</span><span class="af-r-sub" id="syncState">${connected ? '已连接 · 数据库 ' + dbSizeText() : '请先在「备份设置」填写仓库和令牌'}</span></span><span class="af-r-state">${connected ? '私有' : '未配置'}</span></div>` +
    (connected ? `<button class="primary-action" onclick="doSync()">立即备份并同步</button><button class="secondary-action" style="border-color:#cfe0ff;background:#f4f8ff;color:var(--blue)" onclick="doPull()">从云端恢复</button>` : `<button class="primary-action" onclick="openBackupCfg()">去配置备份</button>`) +
    `<p class="auth-note" style="color:var(--muted);margin-top:16px">自动同步只在网页打开且联网时运行。连续修改会合并后同步；多台设备同时编辑时，以最后一次成功同步为准。令牌只保存在本机。</p>`);
}
async function ghRequest(cfg, method, extra) {
  const url = `https://api.github.com/repos/${cfg.user}/${cfg.repo}/contents/ledger.db`;
  const opt = { method, headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } };
  if (extra) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(extra); }
  return fetch(url, opt);
}
function scheduleAutoSync(delay = AUTO_SYNC_DELAY) {
  if (!dirty || !ghReady()) return;
  clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(() => doSync({ automatic: true }), delay);
}
async function doSync(options = {}) {
  const automatic = Boolean(options.automatic);
  if (!ghReady()) return false;
  if (isDbEmpty()) {
    // 关键防护:本地没有任何数据时,绝不把空库推到云端(否则会覆盖/清空云端备份,导致其它设备也变空)
    if (!automatic) { const st0 = document.getElementById('syncState'); if (st0) st0.textContent = '本地无数据,已跳过备份(避免覆盖云端)'; toast('本地没有数据,已跳过备份以免覆盖云端'); }
    setDirty(false);
    return false;
  }
  if (syncRunning) { syncAgain = true; return false; }
  syncRunning = true;
  const syncingVersion = changeVersion;
  const cfg = ghCfg(); const st = document.getElementById('syncState');
  if (st) st.textContent = '同步中…';
  try {
    let sha;
    const head = await ghRequest(cfg, 'GET');
    if (head.ok) { const j = await head.json(); sha = j.sha; }
    const body = { message: '备份账务数据 ' + nowStamp(), content: bytesToB64(db.export()) };
    if (sha) body.sha = sha;
    const r = await ghRequest(cfg, 'PUT', body);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const t = nowStamp(); localStorage.setItem(SYNC_TIME_KEY, t);
    if (changeVersion === syncingVersion) setDirty(false);
    else { setDirty(true); syncAgain = true; }
    if (st) st.textContent = '已同步 ✓ · ' + t + ' · ' + dbSizeText();
    if (!automatic) toast('已备份到 GitHub');
    return true;
  } catch (e) {
    if (st) st.textContent = '同步失败:' + e.message + '(检查令牌/仓库/网络)';
    if (!automatic) toast('同步失败');
    return false;
  } finally {
    syncRunning = false;
    if (syncAgain) { syncAgain = false; scheduleAutoSync(500); }
  }
}
async function pullFromCloud(options = {}) {
  const automatic = Boolean(options.automatic);
  if (!ghReady()) return false;
  const cfg = ghCfg(); const st = document.getElementById('syncState');
  if (st) st.textContent = '恢复中…';
  try {
    const r = await ghRequest(cfg, 'GET');
    if (automatic && r.status === 404) { if (isDbEmpty()) toast('云端还没有备份:请在有数据的设备点「立即备份并同步」'); return false; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const bytes = b64ToBytes(String(j.content || '').replace(/\n/g, ''));
    const localBytes = db.export();
    const localCounts = dbCounts();
    loadBytesIntoDb(bytes);
    const counts = dbCounts();
    const remoteEmpty = !counts.cards && !counts.transactions && !counts.annualFees;
    const localHasData = localCounts.cards || localCounts.transactions || localCounts.annualFees;
    if (automatic && remoteEmpty && localHasData) {
      loadBytesIntoDb(localBytes);
      setDirty(true);
      scheduleAutoSync(500);
      return false;
    }
    await persistNow(); setDirty(false); renderAll();
    if (st) st.textContent = '已从云端恢复 ✓ · ' + dbSizeText() + ' · ' + dbSummary();
    if (!automatic) { closeM(); go('home'); }
    if (counts.cards || counts.transactions || counts.annualFees) {
      if (!automatic) toast(`已恢复 ${counts.cards} 张卡片、${counts.transactions} 条流水`);
    } else {
      if (!automatic) toast('云端数据库为空,请先在有数据的设备点击立即备份');
    }
    return true;
  } catch (e) {
    if (st) st.textContent = '恢复失败:' + e.message;
    // 自动拉取失败时:本地为空才提示(避免每次打开都弹),本地有数据则保留本地、静默
    if (!automatic || isDbEmpty()) toast('云端同步失败:' + e.message + '(将继续用本机数据)');
    return false;
  }
}
async function doPull() {
  if (!window.confirm('从云端拉取会覆盖本机当前数据,确定?')) return;
  return pullFromCloud({ automatic: false });
}
// 汇总某个数据库的关键信息,用于本机/云端对比(canon 用于判断是否完全一致)
function summarizeDb(source) {
  try {
    const cards = allFrom(source, 'SELECT id,user,bank,name,tail,total,fixed,temporary,available,billDay,repayDay FROM cards ORDER BY id');
    const txs = allFrom(source, 'SELECT id,cardId,date,time,amount,note,type,feeRate,limitAmount,instId,instPeriod FROM transactions ORDER BY id');
    const afs = allFrom(source, 'SELECT cardId,id,name,chargeDate,requirement,status,note FROM annual_fees ORDER BY cardId,id');
    let insts = [];
    try { insts = allFrom(source, 'SELECT cardId,id,name,principal,periods,postedBase,perPrincipal,perFee,startDate,occupyLimit,status,note FROM installments ORDER BY cardId,id'); }
    catch (e) { insts = []; }   // 老备份没有这张表
    const totalAvail = cards.reduce((s, c) => s + Number(c.available || 0), 0);
    const lastTx = txs.reduce((m, t) => { const d = String(t.date || ''); return d > m ? d : m; }, '');
    return {
      ok: true, empty: !cards.length && !txs.length && !afs.length && !insts.length,
      cards: cards.length, transactions: txs.length, annualFees: afs.length, installments: insts.length,
      totalAvail, lastTx, canon: JSON.stringify({ cards, txs, afs, insts }),
      raw: { cards, txs, afs, insts }
    };
  } catch (e) { return { ok: false }; }
}
let pendingCloudBytes = null;
function conflictRow(label, l, c) {
  const diff = String(l) !== String(c);
  const vs = 'padding:7px 6px;border-top:1px solid var(--line);text-align:right;' + (diff ? 'color:var(--red);font-weight:700' : 'color:var(--ink)');
  return `<div style="padding:7px 0;border-top:1px solid var(--line);color:var(--muted)">${esc(label)}</div>` +
    `<div style="${vs}">${esc(l)}</div><div style="${vs}">${esc(c)}</div>`;
}
const CNY = n => '¥' + Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const TXTYPE = v => v === 'repayment' ? '还款' : (v === 'expense' ? '消费' : String(v == null ? '' : v));
function showVal(v, fmt) { if (v == null || v === '') return '(空)'; return fmt ? fmt(v) : String(v); }
// 逐条对比两组记录,返回差异描述数组
function diffRecords(localRows, cloudRows, keyOf, labelOf, fields, kindName) {
  const L = new Map(), C = new Map();
  localRows.forEach(r => L.set(keyOf(r), r));
  cloudRows.forEach(r => C.set(keyOf(r), r));
  const keys = new Set([...L.keys(), ...C.keys()]);
  const out = [];
  keys.forEach(k => {
    const a = L.get(k), b = C.get(k);
    if (a && !b) out.push({ tag: '本机独有', color: 'var(--blue)', title: kindName + ' ' + labelOf(a), lines: [] });
    else if (!a && b) out.push({ tag: '云端独有', color: 'var(--orange)', title: kindName + ' ' + labelOf(b), lines: [] });
    else {
      const lines = [];
      fields.forEach(([col, name, fmt]) => {
        if (String(a[col]) !== String(b[col])) lines.push({ name, a: showVal(a[col], fmt), b: showVal(b[col], fmt) });
      });
      if (lines.length) out.push({ tag: '已修改', color: 'var(--red)', title: kindName + ' ' + labelOf(a), lines });
    }
  });
  return out;
}
function computeDiffs(L, C) {
  const cardFields = [['user', '户名'], ['bank', '银行'], ['name', '卡名'], ['tail', '尾号'], ['total', '总额度', CNY], ['fixed', '固定额度', CNY], ['temporary', '临时额度', CNY], ['available', '可用额度', CNY], ['billDay', '账单日'], ['repayDay', '还款日']];
  const txFields = [['date', '日期'], ['time', '时间'], ['type', '类型', TXTYPE], ['amount', '金额', CNY], ['note', '备注'], ['feeRate', '手续费率'], ['limitAmount', '影响额度金额', CNY], ['instPeriod', '分期期号']];
  const afFields = [['name', '名称'], ['chargeDate', '收取日'], ['requirement', '要求'], ['status', '状态'], ['note', '备注']];
  const instFields = [['name', '名称'], ['principal', '总本金', CNY], ['periods', '总期数'], ['postedBase', '已入账基线'], ['perPrincipal', '每期本金', CNY], ['perFee', '每期手续费', CNY], ['startDate', '下次入账日'], ['occupyLimit', '占用额度', v => Number(v) ? '是' : '否'], ['status', '状态'], ['note', '备注']];
  return [].concat(
    diffRecords(L.raw.cards, C.raw.cards, r => r.id, c => `#${c.id} ${c.bank || ''}${c.name ? ' ' + c.name : ''}`.trim(), cardFields, '卡片'),
    diffRecords(L.raw.txs, C.raw.txs, r => r.id, t => `#${t.id} ${t.date || ''} ${TXTYPE(t.type)}`.trim(), txFields, '流水'),
    diffRecords(L.raw.afs, C.raw.afs, r => r.cardId + ':' + r.id, f => `卡#${f.cardId} 规则#${f.id}`, afFields, '年费'),
    diffRecords(L.raw.insts || [], C.raw.insts || [], r => r.cardId + ':' + r.id, n => `卡#${n.cardId} ${n.name || '分期'}`, instFields, '分期')
  );
}
function renderDiffList(diffs) {
  if (!diffs.length) return `<p class="muted" style="margin:8px 0">计数一致,但数据库内容有细微差别(可能是排序或空值)。</p>`;
  const cap = 40; const shown = diffs.slice(0, cap);
  const items = shown.map(d => {
    const head = `<div style="font-size:12px;font-weight:700"><span style="color:${d.color}">[${d.tag}]</span> ${esc(d.title)}</div>`;
    const body = d.lines.map(l => `<div style="font-size:11px;color:var(--muted);margin-top:3px">${esc(l.name)}：<span style="color:var(--red)">${esc(l.a)}</span> <span style="color:var(--muted)">→</span> <span style="color:var(--green)">${esc(l.b)}</span></div>`).join('');
    return `<div style="border-top:1px solid var(--line);padding:9px 0">${head}${body}</div>`;
  }).join('');
  const more = diffs.length > cap ? `<p class="muted" style="margin:8px 0 0">仅显示前 ${cap} 处,共 ${diffs.length} 处差异。</p>` : '';
  return `<div style="margin-top:6px">${items}</div>${more}`;
}
function showSyncConflict(L, C, cloudBytes) {
  pendingCloudBytes = cloudBytes;
  const money = CNY;
  const rows =
    conflictRow('卡片', L.cards + ' 张', C.cards + ' 张') +
    conflictRow('流水', L.transactions + ' 条', C.transactions + ' 条') +
    conflictRow('年费记录', L.annualFees + ' 条', C.annualFees + ' 条') +
    conflictRow('分期', (L.installments || 0) + ' 条', (C.installments || 0) + ' 条') +
    conflictRow('可用额度合计', money(L.totalAvail), money(C.totalAvail)) +
    conflictRow('最近流水', L.lastTx || '—', C.lastTx || '—');
  const diffs = computeDiffs(L, C);
  setModal('数据不一致,请选择',
    `<p class="muted" style="margin:-6px 0 10px">本机数据与云端(GitHub)不一致。下方先是总量对比,再列出逐条差异(<span style="color:var(--red)">红=本机</span> → <span style="color:var(--green)">绿=云端</span>),请选择以哪一份为准:</p>` +
    `<div style="display:grid;grid-template-columns:1.15fr .95fr .95fr;font-size:12px;margin:6px 0 4px">` +
    `<div style="font-weight:700;color:var(--muted);padding:0 0 2px">项目</div>` +
    `<div style="font-weight:700;text-align:right;padding:0 6px 2px">本机</div>` +
    `<div style="font-weight:700;text-align:right;padding:0 6px 2px">云端</div>` +
    rows + `</div>` +
    `<p class="eyebrow" style="margin:16px 0 2px">逐条差异(本机 → 云端)</p>` +
    renderDiffList(diffs) +
    `<button class="primary-action" style="margin-top:16px" onclick="resolveSyncUseCloud()">用云端数据(覆盖本机)</button>` +
    `<button class="secondary-action" style="border-color:#cfe0ff;background:#f4f8ff;color:var(--blue)" onclick="resolveSyncUseLocal()">用本机数据(上传覆盖云端)</button>` +
    `<p class="auth-note" style="color:var(--muted);margin-top:14px">选择后另一份会被覆盖。若想先保留两份,可先在设置里「导出 .db」备份。</p>`);
}
async function resolveSyncUseCloud() {
  if (!pendingCloudBytes) { closeM(); return; }
  const bytes = pendingCloudBytes; pendingCloudBytes = null;
  try {
    loadBytesIntoDb(bytes); await persistNow(); setDirty(false); renderAll();
    closeM(); go('home'); toast('已采用云端数据');
  } catch (e) { toast('载入云端数据失败:' + e.message); }
}
async function resolveSyncUseLocal() {
  pendingCloudBytes = null; closeM();
  const ok = await doSync({ automatic: true });
  toast(ok ? '已用本机数据覆盖云端' : '上传失败,请稍后在「备份与同步」重试');
}
// 登录后自动同步:拉取云端 → 与本机对比 → 有差异让用户选(用本机 or 用云端)
async function syncOnOpen() {
  if (!ghReady() || !navigator.onLine) return;
  const cfg = ghCfg();
  let cloudBytes;
  try {
    const r = await ghRequest(cfg, 'GET');
    if (r.status === 404) {
      // 云端还没有备份:本机有数据就直接上传建立首份备份
      if (!isDbEmpty()) { await doSync({ automatic: true }); }
      return;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    cloudBytes = b64ToBytes(String(j.content || '').replace(/\n/g, ''));
  } catch (e) { toast('云端同步失败:' + e.message + '(继续用本机数据)'); return; }
  const local = summarizeDb(db);
  let cloud; let cdb;
  try { cdb = new SQL.Database(cloudBytes); cloud = summarizeDb(cdb); } catch (e) { cloud = { ok: false }; }
  finally { if (cdb) cdb.close(); }
  if (!cloud.ok) { toast('云端数据无法解析,继续用本机数据'); return; }
  if (cloud.empty && !local.empty) { toast('云端备份为空,已保留本机数据(将自动上传)'); setDirty(true); scheduleAutoSync(500); return; }
  if (local.empty) {
    // 本机无数据:无需询问,直接用云端
    loadBytesIntoDb(cloudBytes); await persistNow(); setDirty(false); renderAll();
    if (!cloud.empty) toast('已从云端载入数据'); return;
  }
  if (local.canon === cloud.canon) { setDirty(false); return; } // 完全一致,静默
  showSyncConflict(local, cloud, cloudBytes);                    // 有差异,交给用户决定
}
function openBackupCfg() {
  const cfg = ghCfg();
  setModal('备份设置',
    `<p class="muted" style="margin:-6px 0 10px">填一次即可。令牌只保存在本机,不会上传,也不进网页代码。仓库务必设为 <b>Private</b>,以免财务数据公开。</p>` +
    `<label class="field-label">GitHub 用户名</label><input id="gUser" class="modal-input" value="${esc(cfg.user || 'huangle0714')}">` +
    `<label class="field-label">私有仓库名</label><input id="gRepo" class="modal-input" value="${esc(cfg.repo || '')}" placeholder="ledger-backup(请设为 Private)">` +
    `<label class="field-label">访问令牌(Fine-grained,仅该仓库 Contents 读写)</label><input id="gToken" class="modal-input" type="password" value="${esc(cfg.token || '')}" placeholder="github_pat_…">` +
    `<button class="primary-action" onclick="saveBackupCfg()">保存设置</button>`);
}
function saveBackupCfg() {
  localStorage.setItem(GH_KEY, JSON.stringify({ user: val('gUser'), repo: val('gRepo'), token: document.getElementById('gToken').value.trim() }));
  updateSyncLabel(); toast('已保存备份设置'); openSync();
  if (dirty) scheduleAutoSync(500);
}
/* ---------- 导出 / 导入 .db ---------- */
function dbTables(source) {
  return allFrom(source, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r => r.name);
}
function allFrom(source, sql, params = []) {
  const stmt = source.prepare(sql); stmt.bind(params); const out = [];
  while (stmt.step()) out.push(stmt.getAsObject()); stmt.free(); return out;
}
function tableColumns(source, table) {
  return allFrom(source, `PRAGMA table_info("${String(table).replace(/"/g, '""')}")`).map(r => String(r.name));
}
function tableRows(source, table) {
  return allFrom(source, `SELECT * FROM "${String(table).replace(/"/g, '""')}"`);
}
function rowValue(row, names, fallback = '') {
  const keys = Object.keys(row); const wanted = names.map(String).map(s => s.toLowerCase());
  const key = keys.find(k => wanted.includes(k.toLowerCase())); return key == null ? fallback : row[key];
}
function rowNumber(row, names, fallback = 0) {
  const n = Number(rowValue(row, names, fallback)); return Number.isFinite(n) ? n : fallback;
}
function chooseLegacyTable(source, kind) {
  const tables = dbTables(source);
  const scored = tables.map(name => {
    const lower = name.toLowerCase(); const cols = tableColumns(source, name).map(c => c.toLowerCase()); let score = 0;
    if (kind === 'card') {
      if (/card|credit|xyk|信用卡/.test(lower)) score += 5;
      if (cols.some(c => /bank|issuer|银行/.test(c))) score += 3;
      if (cols.some(c => /tail|last|card.?no|卡号|尾号/.test(c))) score += 3;
      if (cols.some(c => /limit|total|额度/.test(c))) score += 2;
    } else if (kind === 'tx') {
      if (/transaction|trans|flow|流水|record|消费|还款/.test(lower)) score += 5;
      if (cols.some(c => /amount|金额|消费|还款/.test(c))) score += 3;
      if (cols.some(c => /date|日期|时间/.test(c))) score += 2;
    } else {
      if (/fee|annual|年费/.test(lower)) score += 5;
      if (cols.some(c => /fee|年费|免年费/.test(c))) score += 3;
    }
    return { name, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].name : null;
}
function extractLegacyData(source) {
  const cardTable = chooseLegacyTable(source, 'card');
  if (!cardTable) throw new Error(`无法识别旧数据库表结构(现有表:${dbTables(source).join(', ') || '无'})`);
  const cards = [], cardMap = new Map();
  tableRows(source, cardTable).forEach((row, index) => {
    const oldId = rowValue(row, ['id', 'cardId', 'card_id', '编号'], index + 1);
    const id = Number(oldId) || index + 1; cardMap.set(String(oldId), id);
    const bank = String(rowValue(row, ['bank', 'issuer', 'bankName', '银行', '发卡行'], '未命名银行'));
    const total = rowNumber(row, ['total', 'creditLimit', 'credit_limit', 'limit', '额度', '总额度']);
    const available = rowNumber(row, ['available', 'availableAmount', 'available_amount', '可用额度', '余额'], total);
    cards.push({ id, user: String(rowValue(row, ['user', 'owner', '持卡人'], '')), bank, name: String(rowValue(row, ['name', 'cardName', '卡名'], '')), tail: String(rowValue(row, ['tail', 'last4', 'last_four', 'cardNo', 'card_no', '尾号', '卡号'], '')).slice(-4), total, fixed: rowNumber(row, ['fixed', 'fixedLimit', '固定额度'], total), temporary: rowNumber(row, ['temporary', 'temporaryLimit', '临时额度']), available, billDay: String(rowValue(row, ['billDay', 'bill_day', '账单日'], '')), repayDay: String(rowValue(row, ['repayDay', 'repay_day', '还款日'], '')) });
  });
  const annualFees = [], feeTable = chooseLegacyTable(source, 'fee');
  if (feeTable) tableRows(source, feeTable).forEach((row, index) => annualFees.push({ id: Number(rowValue(row, ['id'], index + 1)) || index + 1, cardId: cardMap.get(String(rowValue(row, ['cardId', 'card_id', 'card', '卡片id'], ''))) || Number(rowValue(row, ['cardId', 'card_id'], 0)), name: String(rowValue(row, ['name', 'feeName', '年费名称'], '年费')), chargeDate: String(rowValue(row, ['chargeDate', 'charge_date', '日期'], '未设置')), requirement: String(rowValue(row, ['requirement', '免年费条件', '条件'], '')), status: String(rowValue(row, ['status', '状态'], 'pending')), note: String(rowValue(row, ['note', '备注'], '')) }));
  const transactions = [], txTable = chooseLegacyTable(source, 'tx');
  if (txTable) tableRows(source, txTable).forEach((row, index) => {
    const oldCard = rowValue(row, ['cardId', 'card_id', 'card', '卡片id'], ''); const cardId = cardMap.get(String(oldCard)) || Number(oldCard);
    if (!cardId) return;
    const typeRaw = String(rowValue(row, ['type', 'kind', '类型'], 'spend')).toLowerCase();
    transactions.push({ id: Number(rowValue(row, ['id'], index + 1)) || index + 1, cardId, date: String(rowValue(row, ['date', 'day', '日期'], todayStr())), time: String(rowValue(row, ['time', '时间'], '')), createdAt: String(rowValue(row, ['createdAt', 'created_at', '创建时间'], '')), amount: rowNumber(row, ['amount', 'money', '金额', '消费金额', '还款金额']), note: String(rowValue(row, ['note', 'remark', '备注'], '')), type: /还款|repay/.test(typeRaw) ? 'repayment' : 'spend', feeRate: rowNumber(row, ['feeRate', 'fee_rate', '手续费率'], DEFAULT_FEE_RATE) });
  });
  return { cards, annualFees, transactions };
}
function loadBytesIntoDb(bytes) {
  let source = new SQL.Database(bytes); let next;
  try {
    const columns = dbTables(source).includes('cards') ? tableColumns(source, 'cards').map(c => c.toLowerCase()) : [];
    if (columns.includes('bank') && columns.includes('total') && columns.includes('available')) {
      next = source; source = null;
      migrate(next);
    } else {
      const data = extractLegacyData(source); next = new SQL.Database(); next.exec(SCHEMA);
      const previous = db; db = next; seedFrom(data); db = previous;
    }
  } catch (error) { if (next && next !== source) next.close(); throw error; } finally { if (source) source.close(); }
  if (db) db.close(); db = next; return next;
}
function openExport() {
  setModal('导出备份', `<p class="muted" style="margin:-6px 0 12px">导出一个 .db 文件,可用任意 SQLite 工具打开,或导入到其它设备。</p><button class="primary-action" onclick="doExport()">下载 ledger-${todayStr()}.db</button>`);
}
function doExport() {
  const blob = new Blob([db.export()], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `ledger-${todayStr()}.db`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('已导出 .db');
}
function openImport() {
  setModal('导入数据', `<p class="muted" style="margin:-6px 0 12px">选择一个 .db 文件导入(会覆盖当前数据)。支持当前格式，也会尝试识别 xyk 的 <b>app.db</b> 并转换卡片、年费和流水。</p>` +
    `<input id="impFile" class="modal-input" type="file" accept=".db,.sqlite,.sqlite3">` +
    `<button class="secondary-action" style="border-color:#cfe0ff;background:#f4f8ff;color:var(--blue)" onclick="doImport()">导入并覆盖</button>`);
}
async function doImport() {
  const f = document.getElementById('impFile').files[0];
  if (!f) { toast('请选择文件'); return; }
  try {
    const buf = await f.arrayBuffer();
    loadBytesIntoDb(new Uint8Array(buf));
    await persistNow(); changeVersion += 1; setDirty(true); scheduleAutoSync(); renderAll(); closeM(); toast('导入成功');
  } catch (e) { toast('导入失败:' + e.message); }
}

/* ---------- 启动 ---------- */
document.getElementById('mb').addEventListener('click', e => { if (e.target.id === 'mb') closeM(); });
document.getElementById('authInput').addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });

async function boot() {
  try {
    await ensureDefaultPass();
    await openDatabase();
    lastCatchUp = await catchUpInstallments();   // 网页无后台进程,打开时把已过入账日的期数补齐
    renderAll();
    updateSyncLabel();
    // 拉取放到登录成功后(showApp),确保"输入密码后才自动拉取 GitHub 数据"
  } catch (e) {
    document.getElementById('authErr').textContent = '初始化失败:' + e.message;
    console.error(e);
  }
}
window.addEventListener('online', () => {
  if (!unlocked) return;      // 未登录不联网同步
  if (dirty) scheduleAutoSync(300);
  else syncOnOpen();
});
boot();

