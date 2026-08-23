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
  amount REAL NOT NULL DEFAULT 0, note TEXT, type TEXT, feeRate REAL);`;

function seedFrom(data) {
  db.exec('BEGIN');
  (data.cards || []).forEach(c => run(
    `INSERT INTO cards(id,user,bank,name,tail,total,fixed,temporary,available,billDay,repayDay) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    [c.id, c.user, c.bank, c.name, c.tail, Number(c.total || 0), Number(c.fixed || 0), Number(c.temporary || 0), Number(c.available || 0), c.billDay, c.repayDay]));
  (data.annualFees || []).forEach(f => run(
    `INSERT INTO annual_fees(id,cardId,name,chargeDate,requirement,status,note) VALUES(?,?,?,?,?,?,?)`,
    [f.id, f.cardId, f.name, f.chargeDate, f.requirement, f.status, f.note]));
  (data.transactions || []).forEach(t => run(
    `INSERT INTO transactions(id,cardId,date,time,createdAt,amount,note,type,feeRate) VALUES(?,?,?,?,?,?,?,?,?)`,
    [t.id, t.cardId, t.date, t.time, t.createdAt, Number(t.amount || 0), t.note, t.type, t.type === 'repayment' ? null : Number(t.feeRate != null ? t.feeRate : DEFAULT_FEE_RATE)]));
  db.exec('COMMIT');
}

async function openDatabase() {
  SQL = await initSqlJs({ locateFile: f => './vendor/' + f });
  const saved = await idbGet(DB_KEY);
  if (saved && saved.byteLength) {
    db = new SQL.Database(new Uint8Array(saved));
  } else {
    db = new SQL.Database();
    db.exec(SCHEMA);
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

function sortedCards() {
  const rows = getCards();
  if (sortKey === 'user') return rows.sort((a, b) => String(a.user).localeCompare(String(b.user), 'zh-Hans-CN', { sensitivity: 'base' }) || String(a.tail).localeCompare(String(b.tail)));
  if (sortKey === 'billDay') return rows.sort((a, b) => (parseBillDay(a.billDay) || 99) - (parseBillDay(b.billDay) || 99) || String(a.tail).localeCompare(String(b.tail)));
  if (sortKey === 'repayDay') return rows.sort((a, b) => (getEffectiveRepayDate(a.repayDay) || '9999-12-31').localeCompare(getEffectiveRepayDate(b.repayDay) || '9999-12-31') || String(a.tail).localeCompare(String(b.tail)));
  return rows;
}

/* ---------- 额度反算(同 xyk server) ---------- */
function applyToAvailable(available, total, tx) {
  const amt = Number(tx.amount || 0);
  if (tx.type === 'repayment') return Math.min(total, available + amt);
  return Math.max(0, available - amt);
}
function reverseFromAvailable(available, total, tx) {
  const amt = Number(tx.amount || 0);
  if (tx.type === 'repayment') return Math.max(0, available - amt);
  return Math.min(total, available + amt);
}
/* ---------- 数据写入 ---------- */
async function addTransaction(cardId, input) {
  const card = getCard(cardId); if (!card) return;
  const type = input.type === 'repayment' ? 'repayment' : 'spend';
  const feeRate = type === 'repayment' ? null : (Number.isFinite(Number(input.feeRate)) && Number(input.feeRate) >= 0 ? Number(input.feeRate) : DEFAULT_FEE_RATE);
  const tx = { cardId, date: input.date, time: input.time || nowTime(), createdAt: nowStamp(), amount: Number(input.amount || 0), note: input.note || (type === 'repayment' ? '还款' : '消费'), type, feeRate };
  const id = nextId('transactions');
  run(`INSERT INTO transactions(id,cardId,date,time,createdAt,amount,note,type,feeRate) VALUES(?,?,?,?,?,?,?,?,?)`,
    [id, tx.cardId, tx.date, tx.time, tx.createdAt, tx.amount, tx.note, tx.type, tx.feeRate]);
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
/* ---------- 渲染 ---------- */
function feeChip(cardId) { const fs = getFees(cardId); if (!fs.length) return '<span class="fee-chip">无年费规则</span>'; return `<span class="fee-chip">年费 ${fs.length} 条规则</span>`; }
function cardUsed(c) { return Math.max(0, Number(c.total) - Number(c.available)); }
function cardStatus(c) { return Number(c.available) >= Number(c.total) ? '已还清' : '待还款'; }
function cardItemHTML(c) {
  const used = cardUsed(c), status = cardStatus(c), mark = markColor(c.bank);
  const due = getEffectiveRepayDate(c.repayDay);
  return `<button class="card-item" onclick="openCard(${c.id})"><span class="bank-mark ${mark}">${esc(shortName(c.bank))}</span>` +
    `<span class="card-main"><strong class="card-name">${esc(c.bank || c.name || '卡片')}</strong>` +
    `<span class="card-sub">${esc(c.user || '')}${c.user ? ' · ' : ''}${esc(c.name || '')} · 尾号 ${esc(c.tail || '----')}</span>${feeChip(c.id)}</span>` +
    `<span class="card-right"><strong class="card-amount">已用 ${yuan(used)}</strong>` +
    `<span class="card-due ${status === '已还清' ? 'ok' : ''}">${due ? '还款 ' + due : esc(c.repayDay || '')} · ${status}</span></span><span class="chevron">›</span></button>`;
}
function renderHome() {
  const cs = getCards();
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
  const cs = sortedCards();
  document.getElementById('cardsCount').textContent = cs.length + ' 张卡片';
  document.getElementById('allCards').innerHTML = cs.length ? cs.map(cardItemHTML).join('') : '<div class="flow-empty">还没有卡片</div>';
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
  document.querySelectorAll('.nav-item').forEach((n, i) => n.classList.toggle('active', ['home', 'cards', 'repayment', 'settings'][i] === p));
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
function setSort(k, label) { sortKey = k; document.getElementById('sortName').textContent = label; renderCards(); closeM(); }
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
}
function lockApp() {
  closeM();
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
    return { cards: count('cards'), transactions: count('transactions'), annualFees: count('annual_fees') };
  } catch (e) {
    return { cards: 0, transactions: 0, annualFees: 0 };
  }
}
function dbSummary() {
  const c = dbCounts();
  return `${c.cards} 张卡片、${c.transactions} 条流水、${c.annualFees} 条年费记录`;
}
function openSync() {
  const cfg = ghCfg();
  const connected = ghReady(cfg);
  const info = connected ? `${esc(cfg.user)} / ${esc(cfg.repo)}` : '尚未配置备份仓库';
  setModal('备份与同步',
    `<p class="muted" style="margin:-6px 0 12px">已启用自动同步：打开网页时自动拉取云端数据，新增、修改或删除后自动备份到 GitHub 私有仓库。</p>` +
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
  if (automatic && dirty) return doSync({ automatic: true });
  const cfg = ghCfg(); const st = document.getElementById('syncState');
  if (st) st.textContent = '恢复中…';
  try {
    const r = await ghRequest(cfg, 'GET');
    if (automatic && r.status === 404) return false;
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
    if (!automatic) toast('恢复失败');
    return false;
  }
}
async function doPull() {
  if (!window.confirm('从云端拉取会覆盖本机当前数据,确定?')) return;
  return pullFromCloud({ automatic: false });
}
async function syncOnOpen() {
  if (!ghReady() || !navigator.onLine) return;
  if (dirty) await doSync({ automatic: true });
  else await pullFromCloud({ automatic: true });
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
      next.exec(SCHEMA);
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
    renderAll();
    updateSyncLabel();
    await syncOnOpen();
  } catch (e) {
    document.getElementById('authErr').textContent = '初始化失败:' + e.message;
    console.error(e);
  }
}
window.addEventListener('online', () => {
  if (dirty) scheduleAutoSync(300);
  else syncOnOpen();
});
boot();

