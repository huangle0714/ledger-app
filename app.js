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
/* 码牌左侧方块的归属名配色:10 色,与银行 5 色分开,名字多也不容易撞色 */
const OWNER_COLORS = ['blue', 'teal', 'orange', 'purple', 'red', 'cyan', 'green', 'magenta', 'brown', 'slate'];
const DUE_SNOOZE_KEY = 'ledger-due-snooze';   // 逾期弹窗「稍后还款」只压当天,不进数据库
const DIFF_SPLIT_KEY = 'ledger-diff-split';   // 还款差额是否拆两笔,记住上次选择
const titles = { home: '总览', cards: '我的卡片', plates: '码牌', settings: '设置' };

let SQL = null;      // sql.js 模块
let db = null;       // 当前数据库
let sortKey = 'repayDay';
let plateSort = 'desc';   // 码牌按上次使用时间:desc=最近在前(默认), asc=最早在前
let plateFilter = 'all';  // all / ali(支付宝) / wx(微信)
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
function nowMinute() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function yuan(n) { return '¥' + Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: (n % 1) ? 2 : 0, maximumFractionDigits: 2 }); }
function signed(n) { return (n < 0 ? '-' : '+') + '¥' + Math.abs(n).toLocaleString('zh-CN', { minimumFractionDigits: (n % 1) ? 2 : 0, maximumFractionDigits: 2 }); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function markColor(s) { let h = 0; for (const ch of String(s || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return MARKS[h % MARKS.length]; }
/* 归属名配色:FNV-1a 32 位 + 末尾混淆。
   不能复用 markColor:它是 h*31,而 31 % 10 == 1,哈希会退化成「字符码之和 mod 10」,
   字序完全失效(「张三」和「三张」必然同色)。FNV-1a 的 16777619 % 10 == 9,对字序敏感。
   注意 (h>>>0) % n 的括号:% 优先级高于 >>>,漏了括号会变成 P[h>>>0] 越界。 */
function ownerHash(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s || '')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 15; h = Math.imul(h, 0x2545f491); h ^= h >>> 13;
  return h >>> 0;
}
/* 光靠哈希不够:10 个色板里放 4 个名字,撞色概率接近一半(1×.9×.8×.7≈50%),
   而用户要的就是「不同名字不同色」。所以按名字排序过一遍,撞了就往后顺延一个颜色,
   ≤10 个归属人保证两两不同色;名字集合没变就直接吃缓存,不重复查库。 */
let ownerColorMap = null, ownerColorKey = null;
function ownerColorTable() {
  const names = [...new Set(getPlates().map(p => String(p.owner || '').trim()).filter(Boolean))].sort();
  const key = names.join('|');
  if (ownerColorMap && ownerColorKey === key) return ownerColorMap;
  const used = new Set(), map = {};
  names.forEach(n => {
    let i = ownerHash(n) % OWNER_COLORS.length;
    for (let k = 0; k < OWNER_COLORS.length && used.has(i); k++) i = (i + 1) % OWNER_COLORS.length;
    used.add(i); map[n] = OWNER_COLORS[i];
  });
  ownerColorKey = key; ownerColorMap = map;
  return map;
}
function ownerColor(s) {
  const n = String(s || '').trim(); if (!n) return OWNER_COLORS[0];
  return ownerColorTable()[n] || OWNER_COLORS[ownerHash(n) % OWNER_COLORS.length];
}
/* 方块里写归属名:1~3 字整名显示(3 字自动缩到 .n3),4 字及以上取前 2 字,没填归属显示灰色 ? */
function ownerMark(owner) {
  const s = String(owner || '').trim();
  if (!s) return { cls: 'none', text: '?' };
  const arr = [...s];
  return { cls: 'oc-' + ownerColor(s) + (arr.length === 3 ? ' n3' : ''), text: arr.length <= 3 ? s : arr.slice(0, 2).join('') };
}
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
  feeMode TEXT, monthRate REAL,
  PRIMARY KEY(cardId, id));
CREATE TABLE IF NOT EXISTS plates(
  id INTEGER PRIMARY KEY, name TEXT, owner TEXT, lastWay TEXT, lastUsedAt TEXT);`;

/* 老库升级:全部 CREATE 都带 IF NOT EXISTS,可反复执行;
   后加的列用 PRAGMA 探测后单独补,老备份读进来一样走这里。
   注意每张表各自判空,不能因为一张表探测不到就整体 return(会漏掉后面的表) */
function tableCols(target, table) {
  try { const s = target.prepare(`PRAGMA table_info(${table})`); const out = []; while (s.step()) out.push(s.getAsObject().name); s.free(); return out; }
  catch (e) { return []; }
}
function addCols(target, table, defs) {
  const cols = tableCols(target, table);
  if (!cols.length) return;
  defs.forEach(([name, type]) => { if (!cols.includes(name)) target.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`); });
}
function migrate(target) {
  target.exec(SCHEMA);
  addCols(target, 'transactions', [['limitAmount', 'REAL'], ['instId', 'INTEGER'], ['instPeriod', 'INTEGER']]);
  /* feeMode 空 = flat(等本等息),老数据行为一个数都不变 */
  addCols(target, 'installments', [['feeMode', 'TEXT'], ['monthRate', 'REAL']]);
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
    `INSERT INTO installments(id,cardId,name,principal,periods,postedBase,perPrincipal,perFee,startDate,occupyLimit,status,note,feeMode,monthRate) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [n.id, n.cardId, n.name, Number(n.principal || 0), Number(n.periods || 1), Number(n.postedBase || 0),
     Number(n.perPrincipal || 0), Number(n.perFee || 0), n.startDate, n.occupyLimit ? 1 : 0, n.status || 'active', n.note || '',
     n.feeMode === 'declining' ? 'declining' : 'flat', Number(n.monthRate || 0)]));
  (data.plates || []).forEach(p => run(
    `INSERT INTO plates(id,name,owner,lastWay,lastUsedAt) VALUES(?,?,?,?,?)`,
    [p.id, p.name || '', p.owner || '', p.lastWay || '', p.lastUsedAt || '']));
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

/* ---------- 逾期还款判定 ----------
   cards 表没有「本期应还」字段,按用户拍板的口径:用记录的流水周期现算。
   本期 = (上一个账单日, 最近一个账单日],本期应还 = 该窗口内的消费合计;
   已还 = 上一个还款日之后记录的还款合计(上个还款日当天那笔是还上一期的,不算进来)。
   所有周期日期都从原点用 addMonthsClamped 现算,绝不做「未来日期回退一月」——
   31 号的卡被夹到 2-28 再回退会永久漂成 1-28,和 instPeriodDate 是同一个坑。 */
function lastBillDate(c, ref) {
  const bd = parseBillDay(c.billDay); if (!bd) return null;
  const r = parseDate(ref);
  const d = dateWithDay(r.getFullYear(), r.getMonth(), bd);
  return d > r ? dateWithDay(r.getFullYear(), r.getMonth() - 1, bd) : d;
}
/* 某个账单日对应的还款日 = 从还款日原点算起、第一个晚于该账单日的实例(单调递增,可二向逼近) */
function repayDateForBill(c, billDate) {
  const orig = parseRepayDate(c.repayDay); if (!orig) return null;
  const o = parseDate(orig);
  let k = (billDate.getFullYear() - o.getFullYear()) * 12 + (billDate.getMonth() - o.getMonth()), g = 0;
  while (addMonthsClamped(o, k) <= billDate && g++ < 600) k += 1;
  g = 0;
  while (addMonthsClamped(o, k - 1) > billDate && g++ < 600) k -= 1;
  return addMonthsClamped(o, k);
}
/* 算一个账单周期。日期都是 YYYY-MM-DD,可以直接字符串比较。
   due/paid 按窗口算(用户拍板:本期应还＝本期账单窗口内的消费);
   owed 是全库跑一遍的欠款余额,只用来兜底压掉误报,理由见 overdueInfo。
   还款归属是不重不漏的:落在 (上一还款日, 本期还款日] 的还款只算进这一期。 */
function cycleDue(c, billDate, ref) {
  const bd = parseBillDay(c.billDay);
  const prevBill = dateWithDay(billDate.getFullYear(), billDate.getMonth() - 1, bd);
  const a = fmtDate(prevBill), b = fmtDate(billDate);
  const pr = fmtDate(repayDateForBill(c, prevBill));
  let due = 0, paid = 0, allSpend = 0, allPaid = 0;
  getTx(c.id).forEach(t => {
    const d = String(t.date || ''); if (!d) return;
    const v = Number(t.amount || 0);
    if (t.type === 'repayment') { if (d <= ref) allPaid += v; if (d > pr && d <= ref) paid += v; }
    else { if (d <= b) allSpend += v; if (d > a && d <= b) due += v; }
  });
  due = money2(due); paid = money2(paid);
  const remain = Math.max(0, money2(due - paid)), owed = Math.max(0, money2(allSpend - allPaid));
  return { bill: b, prevBill: a, repay: fmtDate(repayDateForBill(c, billDate)), due, paid, remain, owed, need: Math.min(remain, owed) };
}
/* 已经过了还款日、还没记到够数还款的卡。判据按用户要求放宽,宁可不报也不误报:
   缺账单日/还款日不判、额度已回满算已还清、本期没消费不判、算出来不差钱不判。
   owed(全库欠款余额)这道闸是必须的:随手消费随手还的人,还款会落到上一期的窗口里,
   只看窗口会天天误报;反过来不能用「本期有单笔≥应还就算还了」那种放宽——
   正常人每月都在上一个还款日还掉整期账单,那笔钱会把本期的逾期永久压住,Task B 就废了。 */
function overdueInfo(c, ref = todayStr()) {
  if (!parseBillDay(c.billDay) || !parseRepayDate(c.repayDay)) return null;
  if (Number(c.available) >= Number(c.total) - 0.01) return null;
  const r = parseDate(ref);
  let bill = lastBillDate(c, ref), info = null, g = 0;
  while (bill && g++ < 3) {                                  // 最近一个「还款日已过」的周期
    const cyc = cycleDue(c, bill, ref);
    if (parseDate(cyc.repay) < r) { info = cyc; break; }
    bill = dateWithDay(bill.getFullYear(), bill.getMonth() - 1, parseBillDay(c.billDay));
  }
  if (!info || info.due <= 0.01 || info.need <= 0.01) return null;
  return { repay: info.repay, days: Math.max(1, Math.round((r - parseDate(info.repay)) / 86400000)), due: info.due, paid: info.paid, remain: info.need };
}
/* 这次还款该冲抵多少:优先用逾期那期的「还差」,没逾期就用当期账单的「还差」(Task C 拿它算差额) */
function dueToRepay(c, ref = todayStr()) {
  const late = overdueInfo(c, ref); if (late) return late;
  if (!parseBillDay(c.billDay) || !parseRepayDate(c.repayDay)) return null;
  const bill = lastBillDate(c, ref); if (!bill) return null;
  const cyc = cycleDue(c, bill, ref);
  return { repay: cyc.repay, days: 0, due: cyc.due, paid: cyc.paid, remain: cyc.need };
}

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

/* modify by huangle 日期:2026-08-25 逾期卡片置顶 */
/* 判一张卡逾期要翻它整张流水(getTx + 最多 3 轮 cycleDue),置顶后排序和渲染各要判一遍。
   同一天、同一份数据结果不会变,按 (日期, changeVersion) 缓存;persist() 会自增
   changeVersion,所以记账/导入/同步之后自动失效,不会拿旧结果糊在界面上。 */
let odCache = new Map(), odCacheKey = '';
function overdueOf(c) {
  const key = todayStr() + '#' + changeVersion;
  if (key !== odCacheKey) { odCache = new Map(); odCacheKey = key; }
  if (odCache.has(c.id)) return odCache.get(c.id);
  const v = overdueInfo(c);
  odCache.set(c.id, v);
  return v;
}
function resetOverdueCache() { odCache = new Map(); odCacheKey = ''; }
/* 逾期的一律排最前面(四种排序都置顶),逾期组内按逾期天数从多到少;
   非逾期的那些卡相对顺序一点不动 —— 只做一次分流,不重排。 */
function overdueFirst(rows) {
  const late = [], rest = [];
  rows.forEach(c => (overdueOf(c) ? late : rest).push(c));
  late.sort((a, b) => overdueOf(b).days - overdueOf(a).days);
  return { late, rest };
}
/* 卡片列表 HTML:有逾期卡时插两条分组小标题,一张不逾期就跟以前一模一样 */
function cardListHTML(rows) {
  const { late, rest } = overdueFirst(rows);
  if (!late.length) return rows.map(cardItemHTML).join('');
  const sum = money2(late.reduce((a, c) => a + Number(overdueOf(c).remain || 0), 0));
  let h = `<div class="grp-h">逾期 ${late.length} 张 · 共 ${yuan(sum)}<i></i></div>` + late.map(cardItemHTML).join('');
  if (rest.length) h += `<div class="grp-h other">其它 ${rest.length} 张<i></i></div>` + rest.map(cardItemHTML).join('');
  return h;
}

/* ---------- 额度反算(同 xyk server) ---------- */
/* 对额度生效的金额:一般等于流水金额;占额度型分期入账时本金早被银行占掉了,
   这里只扣手续费,所以单独存 limitAmount。null 表示按全额扣。 */
function txLimitAmount(tx) {
  if (tx.limitAmount == null || tx.limitAmount === '') return Number(tx.amount || 0);
  const v = Number(tx.limitAmount);
  return Number.isFinite(v) ? v : Number(tx.amount || 0);
}
/* money2 收尾:浮点相加会留下 8500.000000000002 这种尾巴,
   Task C 把一笔还款拆成两笔时,「两笔之和」必须和「一笔」写出完全相同的可用额度。 */
function applyToAvailable(available, total, tx) {
  const amt = txLimitAmount(tx);
  if (tx.type === 'repayment') return money2(Math.min(total, available + amt));
  return money2(Math.max(0, available - amt));
}
function reverseFromAvailable(available, total, tx) {
  const amt = txLimitAmount(tx);
  if (tx.type === 'repayment') return money2(Math.max(0, available - amt));
  return money2(Math.min(total, available + amt));
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

/* 真实年化(IRR,监管披露口径):吃「逐期还款额数组」,二分法解月利率再 ×12。
   等本等息每期一个定额,等额本金每期递减,两种都走这里,不入库每次现算。
   自校验:等额本金的 IRR 恰好等于名义年化(月利率×12),算出来不等就是哪里写错了;
   等本等息约为名义的 2n/(n+1) 倍。 */
function instIRR(principal, pays) {
  principal = Number(principal);
  if (!(principal > 0) || !pays || !pays.length) return null;
  const n = pays.length;
  let tot = 0;
  for (let t = 0; t < n; t++) { const v = Number(pays[t]); if (!(v >= 0)) return null; tot += v; }
  if (!(tot > 0)) return null;
  if (tot <= principal + 1e-9) return 0;   // 总还款不超过本金 = 免息
  const npv = r => { let sum = 0, f = 1; for (let t = 0; t < n; t++) { f *= (1 + r); sum += Number(pays[t]) / f; } return sum - principal; };
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
  const declining = n.feeMode === 'declining';
  const monthRate = Number(n.monthRate || 0);
  const perFee = money2(n.perFee || 0);
  const perP = Number(n.perPrincipal) > 0 ? money2(n.perPrincipal) : money2(principal / periods);
  // 末期本金兜掉除不尽的尾差,保证累计本金恰好等于总本金
  const periodPrincipal = k => (k >= periods ? money2(principal - perP * (periods - 1)) : perP);
  /* 等额本金:当期利息 = 期初剩余本金 x 月利率(不按天),越还越少;
     等本等息:每期同一个数,一直按总本金收。
     小额分期当期利息不足一分时会出现连续多期 0.00,银行也是这样,不当异常处理。 */
  const periodFee = k => {
    if (!declining) return perFee;
    if (!(monthRate > 0)) return 0;
    const openP = principal - perP * (Math.max(1, k) - 1);   // 期初剩余本金
    return money2(Math.max(0, openP) * monthRate);
  };
  /* 逐期计划表:每期日期/本金/利息/共还,对着银行还款计划表可以逐行核对。
     剩余利息一律从这里逐期求和,不能用「每期 x 剩余期数」(那只对等本等息成立)。 */
  const plan = [];
  let feeTotal = 0;
  for (let k = 1; k <= periods; k++) {
    const p = periodPrincipal(k), f = periodFee(k);
    feeTotal = money2(feeTotal + f);
    plan.push({ k, date: instPeriodDate(n, k), p, f, pay: money2(p + f) });
  }
  const posted = instPosted(n);
  const remain = Math.max(0, periods - posted);
  const closed = n.status === 'closed' || remain <= 0;
  const paidP = Math.min(principal, money2(perP * posted));
  const leftP = money2(Math.max(0, principal - paidP));
  const nextK = Math.min(periods, posted + 1);
  const cur = plan[nextK - 1];
  const nextDate = closed ? null : cur.date;
  let pendingFee = 0;
  for (let k = posted + 1; k <= periods; k++) pendingFee = money2(pendingFee + plan[k - 1].f);
  /* 等本等息的现金流沿用原来的算法(principal/periods + perFee),保证老数据年化一个数都不变 */
  const pays = declining ? plan.map(x => x.pay) : new Array(periods).fill(money2(principal / periods + perFee));
  return {
    periods, principal, declining, monthRate, perFee, perP, posted, remain, closed, paidP, leftP, nextK, nextDate, plan,
    curFee: cur.f, perPay: cur.pay, firstPay: plan[0].pay, lastPay: plan[periods - 1].pay,
    feeTotal, pendingFee, payTotal: money2(principal + feeTotal),
    rate: instIRR(principal, pays),
    pct: Math.min(100, Math.max(0, posted / periods * 100)),
    periodPrincipal, periodFee
  };
}
/* 卡片维度汇总:待入账本金 + 占额度型的已占本金 */
function cardInstSummary(cardId) {
  const rows = getInsts(cardId);
  const out = { count: 0, active: 0, pendingP: 0, pendingFee: 0, pendingPay: 0, occupyP: 0, freeP: 0, maxRemain: 0, nextDate: null };
  rows.forEach(n => {
    const i = instInfo(n);
    out.count += 1;
    if (i.closed) return;
    out.active += 1;
    out.pendingP = money2(out.pendingP + i.leftP);
    /* 剩余利息由 instInfo 逐期求和给出(等额本金每期都不一样),和剩余本金分开显示 */
    out.pendingFee = money2(out.pendingFee + i.pendingFee);
    out.maxRemain = Math.max(out.maxRemain, i.remain);
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
  const declining = input.feeMode === 'declining';
  const vals = [input.name || '分期', principal, periods, periods - remaining, perPrincipal,
    declining ? 0 : Number(input.perFee || 0), input.startDate || '', input.occupyLimit ? 1 : 0, input.status || 'active', input.note || '',
    declining ? 'declining' : 'flat', declining ? Number(input.monthRate || 0) : 0];
  if (instId == null) {
    const id = (Number(scalar('SELECT MAX(id) FROM installments WHERE cardId=?', [cardId])) || 0) + 1;
    run(`INSERT INTO installments(id,cardId,name,principal,periods,postedBase,perPrincipal,perFee,startDate,occupyLimit,status,note,feeMode,monthRate) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, cardId].concat(vals));
  } else {
    run(`UPDATE installments SET name=?,principal=?,periods=?,postedBase=?,perPrincipal=?,perFee=?,startDate=?,occupyLimit=?,status=?,note=?,feeMode=?,monthRate=? WHERE cardId=? AND id=?`,
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
      /* 本期金额按期号现算:等额本金每期利息不同,不能拿一个定额一路记下去 */
      const pp = i.periodPrincipal(k);
      const pf = i.periodFee(k);
      await addTransaction(n.cardId, {
        type: 'spend', date: i.nextDate, time: '00:00', amount: money2(pp + pf),
        note: `${n.name || '分期'} 第 ${k}/${i.periods} 期`, feeRate: 0,
        limitAmount: n.occupyLimit ? pf : null,
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
/* 我的卡片列表:年费行下面的分期摘要。没有进行中的分期就整行不输出(自动隐藏);
   已结清的分期不计入,因为它对"还欠多少"没有意义。 */
function cardInstLine(cardId) {
  const s = cardInstSummary(cardId);
  if (!s.active) return '';
  const left = money2(s.pendingP + s.pendingFee);
  /* 多笔分期期数往往不一致,一笔时说"剩余",多笔时说"最长",避免把最大值误读成全部 */
  const term = s.active > 1 ? `最长 ${s.maxRemain} 期` : `剩余 ${s.maxRemain} 期`;
  return `<span class="inst-line"><span class="ii">分</span>` +
    `<span class="it"><span class="it-1">分期 ${s.active} 笔 · ${term}</span>` +
    /* 措辞统一说「利息」:两种计息方式混在一张卡上时不再分词,避免出现"费息"这种要想一下的说法 */
    `<span class="it-2">本金 ${yuan(s.pendingP)}${s.pendingFee > 0 ? ` ＋ 利息 ${yuan(s.pendingFee)}` : ' · 免利息'}</span></span>` +
    `<span class="is">${yuan(left)}</span></span>`;
}
function cardItemHTML(c) {
  const used = cardUsed(c), status = cardStatus(c), mark = markColor(c.bank);
  const due = getEffectiveRepayDate(c.repayDay);
  const dueToday = isRepayOn(c, todayStr());
  /* 逾期优先于「今日还款」,一张卡只挂一个标;这里必须用 late.repay(过去那个还款日),
     getEffectiveRepayDate 永远返回未来日期,拿它显示会说成还没到期。 */
  const late = overdueOf(c);
  return `<button class="card-item ${late ? 'overdue' : (dueToday ? 'due-today' : '')}" onclick="openCard(${c.id})">` +
    `<span class="card-top"><span class="bank-mark ${mark}">${esc(shortName(c.bank))}</span>` +
    `<span class="card-main"><strong class="card-name">${esc(c.bank || c.name || '卡片')}${late ? `<span class="late-badge">逾期 ${late.days} 天</span>` : (dueToday ? '<span class="today-badge">今日还款</span>' : '')}</strong>` +
    `<span class="card-sub">${esc(c.user || '')}${c.user ? ' · ' : ''}${esc(c.name || '')} · 尾号 ${esc(c.tail || '----')}</span></span>` +
    `<span class="card-right"><strong class="card-avail">可用 ${yuan(c.available)}</strong>` +
    `<span class="card-amount">已用 ${yuan(used)}</span>` +
    `<span class="card-due ${late ? 'late' : (dueToday ? 'today' : (status === '已还清' ? 'ok' : ''))}">${late ? `还款 ${late.repay} · 还差 ${yuan(late.remain)}` : `${due ? '还款 ' + due : esc(c.repayDay || '')} · ${status}`}</span>` +
    `${c.billDay ? `<span class="card-bill">账单 ${esc(c.billDay)}</span>` : ''}</span>` +
    `<span class="chevron">›</span></span>` +
    `<span class="card-fees">${cardFeeLines(c.id)}${cardInstLine(c.id)}</span></button>`;
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
  document.getElementById('homeCards').innerHTML = cs.length ? cardListHTML(cs) : '<div class="flow-empty">还没有卡片,去设置里添加</div>';
}
function renderCards() {
  const el = document.getElementById('allCards');
  if (!el) return;
  const cs = sortedCards();
  const cnt = document.getElementById('cardsCount'); if (cnt) cnt.textContent = cs.length + ' 张卡片';
  el.innerHTML = cs.length ? cardListHTML(cs) : '<div class="flow-empty">还没有卡片</div>';
}
function flowItemHTML(tx, tap) {
  const card = getCard(tx.cardId) || {};
  const isPay = tx.type === 'repayment';
  const k = isPay ? 'pay' : 'out';
  const amt = (isPay ? 1 : -1) * Number(tx.amount || 0);
  const settle = isPay ? '' : ` · 到账 ${yuan(Number(tx.amount || 0) - getFeeAmount(tx))}`;
  /* 还款差额没有专门的关联字段(两笔都是普通还款,对可用额度的影响与合成一笔完全等价),
     只按备注认出来加个「差额」小标,方便对账时看出这笔是超出本期应还的部分。 */
  const isDiff = isPay && String(tx.note || '') === '还款差额';
  return `<div class="flow-item ${tap ? 'tap' : ''}" ${tap ? `onclick="confirmDelTx(${tx.id})"` : ''}>` +
    `<span class="flow-ic ${k}">${isPay ? '↓' : '↑'}</span>` +
    `<span class="flow-main"><span class="flow-title">${esc(tx.note || (isPay ? '还款' : '消费'))}${isDiff ? '<i class="diff-chip">差额</i>' : ''}</span>` +
    `<span class="flow-meta">${esc(shortName(card.bank))}${esc(card.tail || '')} · ${esc(tx.date)}${tx.time ? ' ' + esc(tx.time) : ''}${settle}${isDiff ? ' · 超出本期应还' : ''}</span></span>` +
    `<span class="flow-amt ${k}">${signed(amt)}</span></div>`;
}
/* ---------- 码牌页(替换原「还款」页) ---------- */
function wayLabel(w) { return w === 'ali' ? '支付宝' : w === 'wx' ? '微信' : '未使用'; }
/* wayMark(支/微/码)已删除:左侧方块改成归属名配色,渠道只留右侧 .way 标签,信息没丢 */
function wayClass(w) { return w === 'ali' ? 'ali' : w === 'wx' ? 'wx' : 'none'; }

function getPlates() { return all('SELECT * FROM plates ORDER BY id'); }
function getPlate(id) { const r = all('SELECT * FROM plates WHERE id=?', [id]); return r[0] || null; }
async function addPlate(input) {
  const id = nextId('plates');
  run('INSERT INTO plates(id,name,owner,lastWay,lastUsedAt) VALUES(?,?,?,?,?)',
    [id, input.name || '', input.owner || '', input.lastWay || '', input.lastUsedAt || '']);
  await persist(); return id;
}
async function updatePlateUse(id, way, usedAt) {
  run('UPDATE plates SET lastWay=?,lastUsedAt=? WHERE id=?', [way || '', usedAt || '', id]);
  await persist();
}
async function deletePlate(id) { run('DELETE FROM plates WHERE id=?', [id]); await persist(); }

/* 只按上次使用时间排序:desc=最近在前, asc=最早在前;未使用(空时间)永远沉底 */
function sortedPlates() {
  const rows = getPlates().filter(p => plateFilter === 'all' || p.lastWay === plateFilter);
  rows.sort((a, b) => {
    const av = String(a.lastUsedAt || ''), bv = String(b.lastUsedAt || '');
    if (!av && !bv) return Number(b.id) - Number(a.id);
    if (!av) return 1;
    if (!bv) return -1;
    if (av === bv) return Number(b.id) - Number(a.id);
    return plateSort === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
  });
  return rows;
}
function plateItemHTML(p) {
  const wc = wayClass(p.lastWay);
  const om = ownerMark(p.owner);
  const used = p.lastUsedAt ? '上次 ' + esc(String(p.lastUsedAt).slice(5)) : '未使用';
  return `<button class="plate" onclick="openPlateEdit(${p.id})">` +
    `<span class="pm ${om.cls}">${esc(om.text)}</span>` +
    `<span class="plate-main"><span class="plate-name">${esc(p.name || '未命名码牌')}</span>` +
    `<span class="plate-owner">归属 <b>${esc(p.owner || '—')}</b></span></span>` +
    `<span class="plate-right"><span class="way ${wc}">${wayLabel(p.lastWay)}</span>` +
    `<span class="plate-time">${used}</span></span>` +
    `<span class="chevron">›</span></button>`;
}
function renderPlates() {
  const list = document.getElementById('plateList'); if (!list) return;
  const rows = sortedPlates();
  const cnt = document.getElementById('plateCount'); if (cnt) cnt.textContent = '共 ' + rows.length + ' 个';
  const sn = document.getElementById('plateSortName'); if (sn) sn.textContent = plateSort === 'asc' ? '最早在前' : '最近在前';
  document.querySelectorAll('#plateFilter [data-f]').forEach(b => b.classList.toggle('on', b.dataset.f === plateFilter));
  list.innerHTML = rows.length ? rows.map(plateItemHTML).join('')
    : `<div class="flow-empty">${getPlates().length ? '没有符合筛选的码牌' : '还没有码牌，去设置里「添加码牌」'}</div>`;
}
function setPlateFilter(f) { plateFilter = (f === 'ali' || f === 'wx') ? f : 'all'; renderPlates(); }
function openPlateSort() {
  const opts = [['desc', '最近在前', '时间新 → 旧'], ['asc', '最早在前', '时间旧 → 新']];
  setModal('按上次使用时间排序', opts.map(([k, label, sub]) =>
    `<button class="sort-row ${k === plateSort ? 'on' : ''}" onclick="setPlateSort('${k}')"><span>${label}<small>${sub}</small></span><span class="tick">${k === plateSort ? '✓' : ''}</span></button>`).join(''));
}
function setPlateSort(k) { plateSort = k === 'asc' ? 'asc' : 'desc'; renderPlates(); closeM(); }
/* 点码牌 → 编辑:只更新「上次使用方式 + 上次使用时间」,时间默认填当前时间仍可改 */
function openPlateEdit(id) {
  const p = getPlate(id); if (!p) return;
  const w = p.lastWay === 'wx' ? 'wx' : 'ali';   // 默认选中上次方式,新码牌默认支付宝
  setModal('编辑码牌',
    `<div class="plate-ctx"><span class="pm ${ownerMark(p.owner).cls}">${esc(ownerMark(p.owner).text)}</span><div><b>${esc(p.name || '未命名码牌')}</b><small>归属 ${esc(p.owner || '—')}</small></div></div>` +
    `<label class="field-label">上次使用方式</label>` +
    `<div class="way-seg" id="wSeg"><button class="ali ${w === 'ali' ? 'on' : ''}" data-w="ali"><span class="dot">支</span>支付宝</button>` +
    `<button class="wx ${w === 'wx' ? 'on' : ''}" data-w="wx"><span class="dot">微</span>微信</button></div>` +
    `<label class="field-label">上次使用时间 <span class="hint">默认当前时间，可改</span></label>` +
    `<input id="pTime" class="modal-input" value="${esc(nowMinute())}" placeholder="2026-08-24 22:14">` +
    `<button class="primary-action" onclick="savePlateUse(${id})">保存</button>`);
  document.querySelectorAll('#wSeg button').forEach(b => b.onclick = () => {
    document.querySelectorAll('#wSeg button').forEach(x => x.classList.remove('on')); b.classList.add('on');
  });
}
async function savePlateUse(id) {
  const b = document.querySelector('#wSeg button.on');
  const way = b ? b.dataset.w : 'ali';
  const t = val('pTime') || nowMinute();
  await updatePlateUse(id, way, t);
  renderPlates(); closeM(); toast('已更新');
}
/* 设置页:添加码牌(只填名称+归属者)/ 删除码牌 */
function openAddPlate() {
  setModal('添加码牌',
    `<p class="muted" style="margin:-6px 0 10px">新建一个码牌，填名称和归属者即可；使用方式和时间在码牌列表里点开更新。</p>` +
    `<label class="field-label">码牌名称</label><input id="plName" class="modal-input" placeholder="例如 前台收银码牌">` +
    `<label class="field-label">归属者</label><input id="plOwner" class="modal-input" placeholder="例如 张三">` +
    `<button class="primary-action" onclick="saveNewPlate()">保存</button>`);
}
async function saveNewPlate() {
  const name = val('plName'), owner = val('plOwner');
  if (!name) { toast('请输入码牌名称'); return; }
  await addPlate({ name, owner });
  renderPlates(); closeM(); toast('已添加');
}
function openPlateManage() {
  const ps = getPlates();
  setModal('删除码牌', '<p class="muted" style="margin:-6px 0 10px">删除后该码牌记录会被移除，操作不可撤销。</p>' +
    (ps.length ? ps.map(p => `<div class="pick-row"><span class="pm ${ownerMark(p.owner).cls}">${esc(ownerMark(p.owner).text)}</span><span><strong style="font-size:13px">${esc(p.name || '未命名码牌')}</strong><br><span class="muted">归属 ${esc(p.owner || '—')}</span></span><button class="pick-del" onclick="confirmDelPlate(${p.id})">删除</button></div>`).join('') : '<div class="flow-empty">还没有码牌</div>'));
}
function confirmDelPlate(id) {
  const p = getPlate(id); if (!p) return;
  if (window.confirm(`删除码牌「${p.name || '未命名'}」？`)) {
    deletePlate(id).then(() => { renderPlates(); openPlateManage(); toast('已删除'); });
  }
}
/* ---------- 页面切换 ---------- */
/* 每轮整体重绘先清逾期缓存:同步/导入这类不走 persist() 的入口也能拿到新结果 */
function renderAll() { resetOverdueCache(); renderHome(); renderCards(); renderPlates(); }
function go(p) {
  document.querySelectorAll('.page').forEach(x => x.classList.toggle('active', x.dataset.page === p));
  document.querySelectorAll('.nav-item').forEach((n, i) => n.classList.toggle('active', ['home', 'plates', 'settings'][i] === p));
  document.getElementById('pageTitle').textContent = titles[p];
  if (p === 'plates') renderPlates();
  window.scrollTo(0, 0);
}
/* ---------- 弹层通用 ---------- */
function show() { document.getElementById('mb').classList.add('show'); }
function closeM() {
  document.getElementById('mb').classList.remove('show');
  /* 逾期提醒被别的弹层(比如同步冲突)挡住时先记账,等那个弹层关掉再补上 */
  if (pendingDueAlert) { pendingDueAlert = false; setTimeout(maybeShowOverdueAlert, 260); }
}
function setModal(title, html) { document.getElementById('mTitle').textContent = title; document.getElementById('mBody').innerHTML = html; show(); }
function val(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }

/* ---------- 逾期还款提醒弹窗 ----------
   「稍后还款」只压当天,存 localStorage 不进数据库:数据库里加标记会跟着同步跑到别的设备上,
   还会把每天的点击变成同步差异。只要还款没记够,第二天打开照样提醒。 */
let pendingDueAlert = false;
function dueSnoozed() { return localStorage.getItem(DUE_SNOOZE_KEY) === todayStr(); }
function snoozeDue() { localStorage.setItem(DUE_SNOOZE_KEY, todayStr()); closeM(); }
function overdueCards() {
  return getCards().map(c => { const o = overdueOf(c); return o ? Object.assign({ card: c }, o) : null; })
    .filter(Boolean).sort((x, y) => y.days - x.days);
}
function dueGoCard(id) { pendingDueAlert = false; openCard(id); }
/* modify by huangle 日期:2026-08-25 逾期弹窗多选 +「已还款」 */
/* 打开时默认一张都不勾:按钮是灰的,误触也写不进数据。勾选状态只在弹窗开着时有效,不入库。 */
let dueRows = [], duePicked = new Set(), dueSaving = false;
function showOverdueAlert(list) { dueRows = list; duePicked = new Set(); renderDueBody(); }
function duePick(e, id) {
  if (e) { e.stopPropagation(); e.preventDefault(); }   /* 22px 勾选圈只管选中,不要连带跳进卡片 */
  if (duePicked.has(id)) duePicked.delete(id); else duePicked.add(id);
  renderDueBody();
}
function duePickAll() {
  const full = duePicked.size >= dueRows.length;
  duePicked = full ? new Set() : new Set(dueRows.map(x => x.card.id));
  renderDueBody();
}
function renderDueBody() {
  const list = dueRows;
  const total = money2(list.reduce((a, x) => a + Number(x.remain || 0), 0));
  const pick = list.filter(x => duePicked.has(x.card.id));
  const psum = money2(pick.reduce((a, x) => a + Number(x.remain || 0), 0));
  setModal(list.length + ' 张卡要还款',
    `<p class="due-lead">这 ${list.length} 张都过了还款日、还没记到够数的还款。勾上已经还掉的卡,点下面的按钮就按「还差多少」各记一笔还款;点卡片名字那一片,还是照旧进卡片里自己记。</p>` +
    `<div class="pick-bar"><span class="pick-hint">${pick.length ? `已勾 ${pick.length} 张` : '勾选已经还掉的卡'}</span>` +
    `<button class="pick-all" onclick="duePickAll()">${duePicked.size >= list.length ? '全不选' : '全选'}</button></div>` +
    `<div class="due-list">` + list.map(x => {
      const on = duePicked.has(x.card.id);
      return `<div class="due-item${on ? ' picked' : ''}" onclick="dueGoCard(${x.card.id})">` +
        `<span class="due-pick${on ? ' on' : ''}" onclick="duePick(event,${x.card.id})">✓</span>` +
        `<span class="due-main"><span class="due-name">${esc(x.card.bank || x.card.name || '卡片')}<i class="due-badge">逾期 ${x.days} 天</i></span>` +
        `<span class="due-meta">还款日 ${esc(String(x.repay).slice(5))} · ${x.paid > 0.005 ? `已还 ${yuan(x.paid)},还差这些` : '一直没记还款'}</span>` +
        `<span class="due-meta">${esc(x.card.name || '')}${x.card.name ? ' · ' : ''}尾号 ${esc(x.card.tail || '----')}</span></span>` +
        `<span class="due-right"><strong class="due-amt">${yuan(x.remain)}</strong>` +
        `<span class="due-sub">${x.paid > 0.005 ? '应还 ' + yuan(x.due) : '本期应还'}</span></span></div>`;
    }).join('') + `</div>` +
    `<div class="due-total"><span>加起来还要还</span><strong>${yuan(total)}</strong></div>` +
    (pick.length
      ? `<button class="paid-btn" onclick="dueMarkPaid()">已还款 · 记 ${pick.length} 笔 ${yuan(psum)}</button>`
      : `<button class="paid-btn off" disabled>已还款(先勾选卡片)</button>`) +
    `<button class="secondary-action" onclick="snoozeDue()">稍后还款(今天不再提醒)</button>`);
}
/* 勾选后一键记账:每张卡记一笔真实还款(金额=界面上的「还差」,日期=今天,备注「还款」),
   和进卡片手动记一笔完全一样 —— 可用额度照样加回去,流水里看得到,记错了进卡片删掉就行。
   金额恰好等于还差,不会触发「还款差额」拆分;日期是今天,落在本期还款窗口内,逾期随即解除。 */
async function dueMarkPaid() {
  if (dueSaving) return;                                 /* 连点两次会记成两笔,这里挡住 */
  const pick = dueRows.filter(x => duePicked.has(x.card.id) && Number(x.remain) > 0.005);
  if (!pick.length) return;
  dueSaving = true;
  try {
    for (const x of pick) await addTransaction(x.card.id, { type: 'repayment', amount: money2(x.remain), date: todayStr(), note: '还款' });
  } finally { dueSaving = false; }
  duePicked = new Set();
  renderAll();
  toast(`已记 ${pick.length} 笔还款`);
  const left = overdueCards();                           /* 记完重算:全还完就关掉,还有剩的只留没勾的 */
  if (!left.length) { closeM(); return; }
  dueRows = left; renderDueBody();
}
function maybeShowOverdueAlert() {
  if (!unlocked || dueSnoozed()) return;
  const list = overdueCards(); if (!list.length) return;
  if (document.getElementById('mb').classList.contains('show')) { pendingDueAlert = true; return; }
  showOverdueAlert(list);
}

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
let recCard = null;                                     // 当前正在记流水的卡,updateDiff 要现算本期应还
function diffSplitOn() { return localStorage.getItem(DIFF_SPLIT_KEY) !== '0'; }   // 默认开启拆分
function toggleDiffSplit() { localStorage.setItem(DIFF_SPLIT_KEY, diffSplitOn() ? '0' : '1'); updateDiff(); }
function updateSettle() {
  const on = document.querySelector('.type-seg button.on').dataset.t;
  const box = document.getElementById('settleBox');
  if (on === 'spend') {
    box.classList.remove('hide');
    const v = parseFloat(val('recAmt')) || 0, fee = v * DEFAULT_FEE_RATE;
    document.getElementById('recFee').textContent = yuan(+fee.toFixed(2));
    document.getElementById('recSettle').textContent = yuan(+(v - fee).toFixed(2));
  } else box.classList.add('hide');
  updateDiff();
}
/* 还款金额超出「本期应还」时提示会另记一笔「还款差额」。
   口径和卡片列表的逾期判定共用 dueToRepay:逾期就冲那期的还差,没逾期就冲当期的还差。 */
function updateDiff() {
  const box = document.getElementById('diffBox'); if (!box) return;
  const seg = document.querySelector('.type-seg button.on');
  const type = seg ? seg.dataset.t : 'spend';
  const amount = parseFloat(val('recAmt')) || 0;
  const d = (type === 'repayment' && recCard) ? dueToRepay(recCard, val('recDate') || todayStr()) : null;
  const remain = d ? d.remain : 0, extra = money2(amount - remain);
  const save = document.getElementById('recSave');
  if (!d || remain <= 0.005 || extra <= 0.005) {
    box.classList.add('hide');
    if (save) save.textContent = '保存流水';
    return;
  }
  box.classList.remove('hide');
  const on = diffSplitOn();
  document.getElementById('diffText').innerHTML =
    `${d.days > 0 ? '本期还差' : '本期应还'} <b>${yuan(remain)}</b>,超出 <b>${yuan(extra)}</b>` +
    `<span class="dbt">${on ? `会另记一笔「还款差额 ${yuan(extra)}」` : '关掉就只记 1 笔完整还款'}</span>`;
  document.getElementById('diffSw').className = 'sw' + (on ? '' : ' off');
  if (save) save.textContent = on ? '保存(拆成 2 条流水)' : '保存流水';
}
function openRecord(id) {
  const c = getCard(id); if (!c) return;
  recCard = c;
  setModal('记一笔流水',
    `<p class="muted" style="margin:-6px 0 10px">${esc(c.bank || c.name)} · 尾号 ${esc(c.tail || '----')}</p>` +
    `<div class="type-seg"><button class="on" data-t="spend">消费(支出)</button><button data-t="repayment">还款</button></div>` +
    `<label class="field-label">金额</label><input id="recAmt" class="big-amount-input" inputmode="decimal" placeholder="0.00" oninput="updateSettle()">` +
    `<div class="settle-line" id="settleBox"><span>手续费率 0.25% · 手续费 <b id="recFee">¥0</b></span><span>到账 <strong id="recSettle">¥0</strong></span></div>` +
    `<div class="diff-box hide" id="diffBox"><span class="dbi" id="diffText"></span><span class="sw" id="diffSw" onclick="toggleDiffSplit()"></span></div>` +
    `<label class="field-label">日期</label><input id="recDate" class="modal-input" type="date" value="${todayStr()}" onchange="updateDiff()">` +
    `<label class="field-label">备注</label><input id="recNote" class="modal-input" placeholder="例如 超市消费">` +
    `<button class="primary-action" id="recSave" onclick="saveRecord(${id})">保存流水</button>`);
  document.querySelectorAll('.type-seg button').forEach(b => b.onclick = () => { document.querySelectorAll('.type-seg button').forEach(x => x.classList.remove('on')); b.classList.add('on'); updateSettle(); });
  updateSettle();
}
async function saveRecord(id) {
  const type = document.querySelector('.type-seg button.on').dataset.t;
  const amount = parseFloat(val('recAmt')) || 0;
  if (amount <= 0) { toast('请输入金额'); return; }
  const date = val('recDate') || todayStr(), note = val('recNote');
  /* 拆两笔必须先算好本期还差:第一笔记进去之后 paid 就变了,再算会得到 0。
     两笔都是普通还款、都不填 limitAmount,对 available 的影响和一笔完整还款完全等价
     (还款是 min(total, a+x),a+due≤total 时可加,超了两边都顶到 total),所以拆分只影响账面呈现。 */
  const c = getCard(id);
  const d = (type === 'repayment' && diffSplitOn() && c) ? dueToRepay(c, date) : null;
  const remain = d ? d.remain : 0, extra = money2(amount - remain);
  if (d && remain > 0.005 && extra > 0.005) {
    await addTransaction(id, { type, amount: remain, date, note });
    await addTransaction(id, { type, amount: extra, date, note: '还款差额' });
    renderAll(); openCard(id); toast('已记 2 笔 · 差额 ' + yuan(extra));
    return;
  }
  await addTransaction(id, { type, amount, date, note });
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
/* 年化百分数:monthRate 存的是月利率小数,x1200 会带浮点噪声(0.005x1200=6.000000000000001),要收一下 */
function annualPct(monthRate) { return Math.round(Number(monthRate || 0) * 1200 * 1e6) / 1e6; }
function plainNum(v) { return Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: (v % 1) ? 2 : 0, maximumFractionDigits: 2 }); }
function plainNum2(v) { return Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function instRowHTML(cardId, n) {
  const i = instInfo(n);
  const tag = i.closed ? '<span class="inst-tag done">已结清</span>'
    : (n.occupyLimit ? '<span class="inst-tag occupy">占用额度</span>' : '<span class="inst-tag">不占额度</span>');
  /* 计息方式标签和占额度标签并列:两种混在一张卡上时一眼能分开 */
  const modeTag = i.closed ? '' : (i.declining ? '<span class="inst-tag dec">等额本金</span>' : '<span class="inst-tag flat">等本等息</span>');
  const sub = i.closed ? `本金 ${yuan(i.principal)} · 共 ${i.periods} 期`
    : (i.declining
      ? `每期 ${yuan(i.perP)} ＋ 利息 ${yuan(i.curFee)}（本期）· 年化 ${annualPct(i.monthRate).toFixed(2)}%`
      : `每期 ${yuan(i.perP)} ＋ 利息 ${yuan(i.perFee)}`);
  const foot = i.closed ? `本金 ${yuan(i.principal)} · 累计利息 ${yuan(i.feeTotal)}`
    : `下次入账 ${esc(i.nextDate || '未设置')} · 剩余本金 ${yuan(i.leftP)}`;
  return `<div class="inst-row${i.closed ? ' settled' : ''}" onclick="openEditInst(${cardId},${n.id})">` +
    `<div class="ir-top"><span class="ir-ic">${i.closed ? '✓' : '分'}</span>` +
    `<span class="ir-body"><span class="ir-title">${esc(n.name || '分期')} ${Number(i.principal).toLocaleString('zh-CN')}${tag}${modeTag}</span><span class="ir-sub">${sub}</span></span>` +
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
    `<p class="muted" style="margin:-6px 0 12px">${esc(c.bank || c.name)} · 尾号 ${esc(c.tail || '----')} — 点任意一笔可编辑或查看逐期计划；到入账日打开网页会自动记账</p>` +
    list +
    (rows.length ? `<div class="rate-legend"><em>档位</em><span class="rate-chip free">免息</span><span class="rate-chip low">&lt; 8%</span><span class="rate-chip mid">8 ~ 15%</span><span class="rate-chip high">≥ 15%</span></div>` : '') +
    `<button class="add-rule" onclick="openAddInst(${id})">＋ 新增分期</button>`);
}

/* 逐期计划表:每期日期/本金/利息/共还,对着银行的还款计划表逐行核对。
   默认只展开 6 行,长分期不至于把弹层撑太长。 */
function openInstPlan(cardId, instId, all) {
  const c = getCard(cardId), n = getInst(cardId, instId);
  if (!c || !n) return;
  const i = instInfo(n);
  const show = all ? i.periods : Math.min(i.periods, 6);
  let rows = '';
  for (let k = 1; k <= show; k++) {
    const r = i.plan[k - 1];
    const cls = k <= i.posted ? ' paid' : (!i.closed && k === i.nextK ? ' next' : '');
    rows += `<div class="plan-row${cls}"><span class="pn">${k}</span><span class="pd">${r.date ? esc(r.date.slice(5)) : '--'}</span>` +
      `<span>${plainNum(r.p)}</span><span>${plainNum2(r.f)}</span><b>${plainNum2(r.pay)}</b></div>`;
  }
  const more = show < i.periods
    ? `<button class="plan-more" onclick="openInstPlan(${cardId},${instId},1)">展开剩余 ${i.periods - show} 期 ▾</button>` : '';
  const head = i.declining
    ? `每期本金 ${yuan(i.perP)}，利息按期初剩余本金 × 月利率 ${(annualPct(i.monthRate) / 12).toFixed(3)}% 算，共还 ${yuan(i.firstPay)}<span class="dec-arrow">→</span>${yuan(i.lastPay)}`
    : `每期本金 ${yuan(i.perP)} ＋ 利息 ${yuan(i.perFee)}，每期共还 ${yuan(i.perPay)}`;
  setModal('逐期计划',
    `<p class="muted" style="margin:-6px 0 4px">${esc(n.name || '分期')} · ${esc(c.bank || c.name)} 尾号 ${esc(c.tail || '----')}</p>` +
    `<p class="muted" style="margin:0 0 2px;font-size:11px">${head}</p>` +
    `<div class="plan-wrap">` +
    `<div class="plan-head"><span>期</span><span>日期</span><span>本金</span><span>利息</span><span>共还</span></div>` +
    rows + more +
    `<div class="plan-foot"><span>合计 本金 ${yuan(i.principal)} ＋ 利息 ${yuan(i.feeTotal)}</span><b>${yuan(i.payTotal)}</b></div>` +
    `</div>` +
    `<p class="muted" style="margin:9px 0 0;font-size:11px">灰行已入账（额度已扣过），蓝行是下一期，白行还没到。已入账 ${i.posted} / ${i.periods} 期，剩余待入账 本金 ${yuan(i.leftP)} ＋ 利息 ${yuan(i.pendingFee)}。末期本金兜掉了除不尽的尾差，累计恰好等于总本金。</p>` +
    `<button class="secondary-action" style="border-color:#cfe0ff;background:#f4f8ff;color:var(--blue)" onclick="openEditInst(${cardId},${instId})">返回这笔分期</button>` +
    `<button class="secondary-action" onclick="openInsts(${cardId})">返回分期列表</button>`);
}

/* 表单:边填边算真实年化,金额一改预览就跟着变 */
function instModeSel() { const b = document.querySelector('#iMode button.on'); return b && b.dataset.m === 'declining' ? 'declining' : 'flat'; }
/* 预览用一条临时分期喂 instInfo,保证预览和真正入账走的是同一套算法,不会两边算法漂移。
   cardId/id 给 -1,查不到入账流水,posted 恒为 0。 */
function previewInstInfo() {
  const mode = instModeSel();
  const rate = parseFloat(val('iRate')) || 0;
  return instInfo({
    cardId: -1, id: -1, name: '', principal: parseFloat(val('iPrincipal')) || 0,
    periods: Math.max(1, Math.round(parseFloat(val('iPeriods')) || 0) || 1), postedBase: 0,
    perPrincipal: parseFloat(val('iPerP')) || 0, perFee: mode === 'declining' ? 0 : (parseFloat(val('iFee')) || 0),
    startDate: val('iStart'), occupyLimit: 0, status: 'active',
    feeMode: mode, monthRate: mode === 'declining' && rate > 0 ? rate / 1200 : 0
  });
}
function updateInstPreview() {
  const box = document.getElementById('instPrev'); if (!box) return;
  const i = previewInstInfo();
  const hint = document.getElementById('iPerHint');
  if (i.declining) {
    if (hint) hint.textContent = i.perP
      ? `每期本金 ${yuan(i.perP)}，首期共还 ${yuan(i.firstPay)}，末期共还 ${yuan(i.lastPay)}，利息合计 ${yuan(i.feeTotal)}，总还 ${yuan(i.payTotal)}`
      : '填入总本金和期数后自动计算';
    box.innerHTML = i.principal > 0 && i.monthRate > 0
      ? `<span>月利率 ${(annualPct(i.monthRate) / 12).toFixed(3)}% · 名义年化 ${annualPct(i.monthRate).toFixed(2)}%</span>${rateChipHTML(i.rate)}`
      : `<span>填入年化利率后显示测算</span>`;
    return;
  }
  const monthly = i.principal > 0 ? i.perFee / i.principal : 0;
  if (hint) hint.textContent = i.perP ? `每期本金 ${yuan(i.perP)}，每期共还 ${yuan(i.perPay)}` : '填入总本金和期数后自动计算';
  box.innerHTML = i.principal > 0 && i.perPay > 0
    ? `<span>月费率 ${(monthly * 100).toFixed(3)}% · 名义年化 ${(monthly * 12 * 100).toFixed(2)}%</span>${rateChipHTML(i.rate)}`
    : `<span>填入金额后显示真实年化</span>`;
}
/* 两种计息方式共用一个输入位:等本等息填每期手续费,等额本金填年化利率,只切标签不切界面 */
function syncInstMode() {
  const dec = instModeSel() === 'declining';
  const fw = document.getElementById('iFeeWrap'), rw = document.getElementById('iRateWrap'), mh = document.getElementById('iModeHint');
  if (fw) fw.style.display = dec ? 'none' : '';
  if (rw) rw.style.display = dec ? '' : 'none';
  if (mh) mh.textContent = dec
    ? '等额本金：每期本金固定，利息＝期初剩余本金 × 月利率，越还越少。'
    : '等本等息：每期手续费是同一个数，一直按总本金收。';
  updateInstPreview();
}
function instForm(n) {
  const occupy = n ? Number(n.occupyLimit) : 0;
  const dec = !!(n && n.feeMode === 'declining');
  const i = n ? instInfo(n) : null;
  const rateVal = dec && Number(n.monthRate) > 0 ? annualPct(n.monthRate) : '';
  return `<div class="type-seg" id="iSeg"><button class="${occupy ? '' : 'on'}" data-o="0">不占额度</button><button class="${occupy ? 'on' : ''}" data-o="1">占用额度</button></div>` +
    `<p class="muted" style="margin:8px 0 2px;font-size:11px">不占额度：每期扣「本金＋利息」。占用额度：本金已被银行扣掉，每期只扣利息。可用额度始终照抄银行 APP。</p>` +
    `<div class="type-seg" id="iMode" style="margin-top:12px"><button class="${dec ? '' : 'on'}" data-m="flat">等本等息</button><button class="${dec ? 'on' : ''}" data-m="declining">等额本金</button></div>` +
    `<p class="muted" id="iModeHint" style="margin:8px 0 2px;font-size:11px">等本等息：每期手续费是同一个数，一直按总本金收。</p>` +
    `<label class="field-label">分期名称</label><input id="iName" class="modal-input" value="${esc(n ? n.name : '')}" placeholder="例如 消费分期 / 账单分期">` +
    `<label class="field-label">总本金</label><input id="iPrincipal" class="modal-input" inputmode="decimal" value="${n ? Number(n.principal) : ''}" placeholder="例如 48000" oninput="updateInstPreview()">` +
    `<label class="field-label">总期数 / 剩余期数</label><div class="query-bar"><input id="iPeriods" class="modal-input" inputmode="numeric" value="${n ? Number(n.periods) : ''}" placeholder="12" oninput="updateInstPreview()"><input id="iRemain" class="modal-input" inputmode="numeric" value="${i ? i.remain : ''}" placeholder="剩余 12"></div>` +
    `<label class="field-label">每期本金（留空按总本金÷期数）</label><input id="iPerP" class="modal-input" inputmode="decimal" value="${n && Number(n.perPrincipal) ? Number(n.perPrincipal) : ''}" placeholder="自动计算" oninput="updateInstPreview()">` +
    `<div id="iFeeWrap"${dec ? ' style="display:none"' : ''}><label class="field-label">每期手续费</label><input id="iFee" class="modal-input" inputmode="decimal" value="${n && !dec ? Number(n.perFee) : ''}" placeholder="例如 66.53" oninput="updateInstPreview()"></div>` +
    `<div id="iRateWrap"${dec ? '' : ' style="display:none"'}><label class="field-label">年化利率（%）</label><input id="iRate" class="modal-input" inputmode="decimal" value="${rateVal}" placeholder="例如 6" oninput="updateInstPreview()">` +
    `<p class="muted" style="margin:6px 0 0;font-size:11px">照抄银行分期详情页的「年化利率」那个数，别的都不用填，程序 ÷12 得月利率。这是唯一能做到逐期零误差的填法。</p></div>` +
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
  document.querySelectorAll('#iMode button').forEach(b => b.onclick = () => {
    document.querySelectorAll('#iMode button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    syncInstMode();
  });
  syncInstMode();
}
function readInstForm() {
  const seg = document.querySelector('#iSeg button.on');
  const mode = instModeSel();
  const rateRaw = val('iRate');
  const rate = parseFloat(rateRaw) || 0;
  return {
    name: val('iName') || '分期', principal: parseFloat(val('iPrincipal')) || 0,
    periods: parseFloat(val('iPeriods')) || 0, remaining: val('iRemain') === '' ? null : parseFloat(val('iRemain')),
    perPrincipal: parseFloat(val('iPerP')) || 0, perFee: mode === 'declining' ? 0 : (parseFloat(val('iFee')) || 0),
    feeMode: mode, monthRate: mode === 'declining' && rate > 0 ? rate / 1200 : 0, rateRaw,
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
    `<button class="secondary-action" style="border-color:#cfe0ff;background:#f4f8ff;color:var(--blue)" onclick="openInstPlan(${id},${instId},0)">查看逐期计划（${i.periods} 期）</button>` +
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
  /* 等额本金必须有年化利率才能逐期算利息;填 0 是允许的(等于免息分期),只拦空着不填 */
  if (input.feeMode === 'declining' && String(input.rateRaw || '').trim() === '') { toast('请输入年化利率（照抄银行分期详情页）'); return; }
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
  // 逾期提醒挂在同步之后:同步可能改数据、也可能自己弹冲突框抢走 #mb,拉完再判才准
  syncOnOpen().finally(() => maybeShowOverdueAlert());
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
    return { cards: count('cards'), transactions: count('transactions'), annualFees: count('annual_fees'), installments: count('installments'), plates: count('plates') };
  } catch (e) {
    return { cards: 0, transactions: 0, annualFees: 0, installments: 0, plates: 0 };
  }
}
function isDbEmpty() { const c = dbCounts(); return !c.cards && !c.transactions && !c.annualFees && !c.installments && !c.plates; }
function dbSummary() {
  const c = dbCounts();
  return `${c.cards} 张卡片、${c.transactions} 条流水、${c.annualFees} 条年费记录、${c.installments} 条分期、${c.plates} 个码牌`;
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
async function ghRequest(cfg, method, extra, accept) {
  const url = `https://api.github.com/repos/${cfg.user}/${cfg.repo}/contents/ledger.db`;
  const opt = { method, headers: { Authorization: 'Bearer ' + cfg.token, Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } };
  if (extra) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(extra); }
  return fetch(url, opt);
}
/* SQLite 文件头恒为 "SQLite format 3\0"。拿它当「取回来的到底是不是数据库」的判据,
   比事后猜「为什么解析不了」可靠得多。 */
function looksLikeSqlite(bytes) {
  const magic = 'SQLite format 3';
  if (!bytes || bytes.length < 16) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic.charCodeAt(i)) return false;
  return true;
}
/* 取云端数据库的原始字节。
   踩过的坑:GitHub Contents API 默认的 JSON 形式只对 1MB 以内的文件返回 base64 content,
   超过 1MB 时 content 变成空字符串、encoding 变成 "none",而 PUT 上传并不受这个限制。
   于是表现成「刚刚同步成功,一打开却说云端数据无法解析」——库一过 1MB 就必现,
   而且备份其实是好的,只是读不回来。官方指定解法是改用 raw 媒体类型直接取文件本体,
   顺带省掉 base64 那 33% 的流量。仍保留 JSON+base64 回退,防中间层把 Accept 改回去。 */
async function ghFetchDbBytes(cfg) {
  const r = await ghRequest(cfg, 'GET', null, 'application/vnd.github.raw+json');
  if (r.status === 404) return { status: 404 };
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const raw = new Uint8Array(await r.arrayBuffer());
  if (looksLikeSqlite(raw)) return { status: 200, bytes: raw };
  let j = null;
  try { j = JSON.parse(new TextDecoder().decode(raw)); } catch (e) { j = null; }
  if (j && typeof j.content === 'string' && j.content) {
    const b = b64ToBytes(j.content.replace(/\s/g, ''));
    if (looksLikeSqlite(b)) return { status: 200, bytes: b };
  }
  if (j && j.encoding === 'none') throw new Error('云端备份 ' + Math.round(Number(j.size || 0) / 1024) + 'KB 超出接口 1MB 上限,且 raw 方式未生效');
  throw new Error('取回的不是数据库文件(' + raw.length + ' 字节)');
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
    /* 只要 sha,用 object 媒体类型:它对超过 1MB 的文件也照常返回 sha(只是 content 为空),
       比默认 JSON 稳。拿不到 sha 会导致 PUT 被 GitHub 拒(缺 sha),备份就断了。 */
    const head = await ghRequest(cfg, 'GET', null, 'application/vnd.github.object+json');
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
    const got = await ghFetchDbBytes(cfg);
    if (automatic && got.status === 404) { if (isDbEmpty()) toast('云端还没有备份:请在有数据的设备点「立即备份并同步」'); return false; }
    if (got.status === 404) throw new Error('云端还没有备份文件');
    const bytes = got.bytes;
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
    try { insts = allFrom(source, 'SELECT cardId,id,name,principal,periods,postedBase,perPrincipal,perFee,startDate,occupyLimit,status,note,feeMode,monthRate FROM installments ORDER BY cardId,id'); }
    catch (e) { insts = []; }   // 老备份没有这张表
    let plates = [];
    try { plates = allFrom(source, 'SELECT id,name,owner,lastWay,lastUsedAt FROM plates ORDER BY id'); }
    catch (e) { plates = []; }  // 老备份没有码牌表
    const totalAvail = cards.reduce((s, c) => s + Number(c.available || 0), 0);
    const lastTx = txs.reduce((m, t) => { const d = String(t.date || ''); return d > m ? d : m; }, '');
    return {
      ok: true, empty: !cards.length && !txs.length && !afs.length && !insts.length && !plates.length,
      cards: cards.length, transactions: txs.length, annualFees: afs.length, installments: insts.length, plates: plates.length,
      totalAvail, lastTx, canon: JSON.stringify({ cards, txs, afs, insts, plates }),
      raw: { cards, txs, afs, insts, plates }
    };
  } catch (e) { return { ok: false, err: e.message }; }
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
  const instFields = [['name', '名称'], ['principal', '总本金', CNY], ['periods', '总期数'], ['postedBase', '已入账基线'], ['perPrincipal', '每期本金', CNY], ['perFee', '每期手续费', CNY], ['feeMode', '计息方式', v => v === 'declining' ? '等额本金' : '等本等息'], ['monthRate', '年化利率', v => (Number(v || 0) * 1200).toFixed(2) + '%'], ['startDate', '下次入账日'], ['occupyLimit', '占用额度', v => Number(v) ? '是' : '否'], ['status', '状态'], ['note', '备注']];
  const plateFields = [['name', '名称'], ['owner', '归属者'], ['lastWay', '上次方式', wayLabel], ['lastUsedAt', '上次时间']];
  return [].concat(
    diffRecords(L.raw.cards, C.raw.cards, r => r.id, c => `#${c.id} ${c.bank || ''}${c.name ? ' ' + c.name : ''}`.trim(), cardFields, '卡片'),
    diffRecords(L.raw.txs, C.raw.txs, r => r.id, t => `#${t.id} ${t.date || ''} ${TXTYPE(t.type)}`.trim(), txFields, '流水'),
    diffRecords(L.raw.afs, C.raw.afs, r => r.cardId + ':' + r.id, f => `卡#${f.cardId} 规则#${f.id}`, afFields, '年费'),
    diffRecords(L.raw.insts || [], C.raw.insts || [], r => r.cardId + ':' + r.id, n => `卡#${n.cardId} ${n.name || '分期'}`, instFields, '分期'),
    diffRecords(L.raw.plates || [], C.raw.plates || [], r => r.id, p => `${p.name || '#' + p.id}`, plateFields, '码牌')
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
    conflictRow('码牌', (L.plates || 0) + ' 个', (C.plates || 0) + ' 个') +
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
    const got = await ghFetchDbBytes(cfg);
    if (got.status === 404) {
      // 云端还没有备份:本机有数据就直接上传建立首份备份
      if (!isDbEmpty()) { await doSync({ automatic: true }); }
      return;
    }
    cloudBytes = got.bytes;
  } catch (e) { toast('云端同步失败:' + e.message + '(继续用本机数据)'); return; }
  const local = summarizeDb(db);
  let cloud; let cdb;
  /* 云端那份可能是旧版本设备备份的,表结构比现在少列(比如分期的 feeMode/monthRate)。
     临时库先跑一遍 migrate 再读,否则查询会报 no such column,又被当成「无法解析」。
     cdb 只活在内存里,close 掉就没了,不会改动云端文件。 */
  try { cdb = new SQL.Database(cloudBytes); migrate(cdb); cloud = summarizeDb(cdb); } catch (e) { cloud = { ok: false, err: e.message }; }
  finally { if (cdb) cdb.close(); }
  if (!cloud.ok) { toast('云端数据无法解析:' + (cloud.err || '未知原因') + ',继续用本机数据'); return; }
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

