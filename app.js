const cards=[
  {bank:'招商银行',short:'招行',mark:'blue',last:'8019',limit:50000,used:1463,due:'8月1日',status:'已还清',urgent:false},
  {bank:'中国银行',short:'中行',mark:'red',last:'6131',limit:80000,used:11427,due:'8月2日',status:'待还款',urgent:true},
  {bank:'交通银行',short:'交行',mark:'orange',last:'4905',limit:193242,used:101379,due:'8月3日',status:'待还款',urgent:true},
  {bank:'工商银行',short:'工行',mark:'red',last:'2118',limit:64500,used:16547,due:'8月5日',status:'已还清',urgent:false},
  {bank:'平安银行',short:'平安',mark:'teal',last:'6787',limit:100000,used:3049,due:'8月6日',status:'已还清',urgent:false},
  {bank:'浦发银行',short:'浦发',mark:'purple',last:'2306',limit:0,used:0,due:'8月7日',status:'未使用',urgent:false},
  {bank:'建设银行',short:'建行',mark:'blue',last:'4666',limit:120000,used:72409,due:'8月8日',status:'待还款',urgent:true},
  {bank:'广发银行',short:'广发',mark:'orange',last:'4078',limit:200000,used:59133.03,due:'8月10日',status:'已还清',urgent:false},
  {bank:'上海银行',short:'上海',mark:'teal',last:'7142',limit:120000,used:72370.70,due:'8月11日',status:'待还款',urgent:false},
  {bank:'农业银行',short:'农行',mark:'teal',last:'7280',limit:75000,used:12749,due:'8月13日',status:'已还清',urgent:false},
  {bank:'民生银行',short:'民生',mark:'purple',last:'5815',limit:50000,used:1383,due:'8月14日',status:'已还清',urgent:false},
  {bank:'兴业银行',short:'兴业',mark:'blue',last:'7752',limit:120000,used:71787,due:'8月16日',status:'待还款',urgent:false}
];
const bills=[cards[1],cards[2],cards[6]];
const money=n=>`¥${Number(n).toLocaleString('zh-CN',{minimumFractionDigits:n%1?2:0,maximumFractionDigits:2})}`;
const cardHtml=c=>`<button class="card-item" data-card="${c.last}"><span class="bank-mark ${c.mark}">${c.short}</span><span class="card-main"><strong class="card-name">${c.bank}</strong><span class="card-sub">信用卡 · 尾号 ${c.last}</span></span><span class="card-right"><strong class="card-amount">${money(c.used)}</strong><span class="card-due ${c.urgent?'':'ok'}">${c.due} · ${c.status}</span></span><span class="chevron">›</span></button>`;
const billHtml=c=>`<article class="bill-item"><div class="bill-top"><span class="bill-date">${c.due} · ${c.bank}</span><span class="bill-status">待还款</span></div><div class="bill-bank"><span class="bank-mark ${c.mark}" style="width:26px;height:26px;border-radius:8px;font-size:9px">${c.short}</span><span>尾号 ${c.last}</span><strong class="bill-amount">${money(c.used)}</strong></div><div class="bill-bottom"><span>预计最低还款 ¥${Math.round(c.used*.1).toLocaleString()}</span><span>账单日 账单已生成</span></div></article>`;
document.getElementById('homeCards').innerHTML=cards.slice(0,4).map(cardHtml).join('');
document.getElementById('allCards').innerHTML=cards.map(cardHtml).join('');
document.getElementById('billList').innerHTML=bills.map(billHtml).join('');
const pageTitle={home:'总览',cards:'我的卡片',repayment:'还款',settings:'设置'};
function go(page){document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.dataset.page===page));document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.nav===page));document.getElementById('pageTitle').textContent=pageTitle[page];window.scrollTo({top:0,behavior:'smooth'});}
document.querySelectorAll('[data-nav]').forEach(el=>el.addEventListener('click',()=>go(el.dataset.nav)));
document.querySelector('[data-action="settings"]').addEventListener('click',()=>go('settings'));
document.querySelector('[data-action="filter"]').addEventListener('click',()=>document.getElementById('filterRow').classList.toggle('show'));
document.querySelectorAll('.chip').forEach(chip=>chip.addEventListener('click',()=>{document.querySelectorAll('.chip').forEach(c=>c.classList.remove('selected'));chip.classList.add('selected');filterCards(chip.dataset.filter)}));
document.getElementById('searchInput').addEventListener('input',e=>filterCards('search',e.target.value));
function filterCards(type,value=''){const q=value.trim().toLowerCase();const active=document.querySelector('.chip.selected')?.dataset.filter||'all';let list=cards;if(type==='search'&&q)list=cards.filter(c=>(c.bank+c.last+c.short).toLowerCase().includes(q));else if(active==='urgent')list=cards.filter(c=>c.urgent);else if(active==='available')list=cards.filter(c=>c.limit-c.used>0);document.getElementById('allCards').innerHTML=list.map(cardHtml).join('');document.getElementById('cardsCount').textContent=`${list.length} 张卡片`;bindCards();}
function bindCards(){document.querySelectorAll('[data-card]').forEach(el=>el.addEventListener('click',()=>openCard(el.dataset.card)))}
function openCard(last){const c=cards.find(x=>x.last===last);if(!c)return;document.getElementById('modalTitle').textContent='卡片详情';document.getElementById('modalBody').innerHTML=`<div class="detail-hero"><span class="bank-mark ${c.mark}">${c.short}</span><div><strong>${c.bank}</strong><span>信用卡 · 尾号 ${c.last}</span></div></div><div class="detail-amount">${money(c.used)}</div><div class="detail-caption">当前已用额度</div><div class="detail-progress"><span style="width:${c.limit?Math.min(100,c.used/c.limit*100):0}%"></span></div><div class="detail-grid"><div class="detail-cell"><span>总额度</span><strong>${money(c.limit)}</strong></div><div class="detail-cell"><span>可用额度</span><strong>${money(Math.max(0,c.limit-c.used))}</strong></div></div><div class="detail-row"><span>账单日</span><strong>每月 ${c.due.replace('8月','')}</strong></div><div class="detail-row"><span>还款日</span><strong>${c.due}</strong></div><button class="primary-action" data-action="edit">编辑卡片信息</button>`;showModal();}
function showModal(){const m=document.getElementById('modalBackdrop');m.classList.add('show');m.setAttribute('aria-hidden','false')}
function closeModal(){const m=document.getElementById('modalBackdrop');m.classList.remove('show');m.setAttribute('aria-hidden','true')}
document.getElementById('modalBackdrop').addEventListener('click',e=>{if(e.target.id==='modalBackdrop'||e.target.closest('[data-action="close"]'))closeModal()});
document.querySelector('[data-action="add"]').addEventListener('click',()=>{document.getElementById('modalTitle').textContent='添加新卡片';document.getElementById('modalBody').innerHTML='<div class="detail-grid"><label class="detail-cell"><span>发卡银行</span><input class="modal-input" placeholder="例如 招商银行"></label><label class="detail-cell"><span>卡号后四位</span><input class="modal-input" inputmode="numeric" maxlength="4" placeholder="8019"></label><label class="detail-cell"><span>总额度</span><input class="modal-input" inputmode="decimal" placeholder="50000"></label><label class="detail-cell"><span>还款日</span><input class="modal-input" placeholder="每月 1 日"></label></div><button class="primary-action" data-action="save">保存卡片</button>';showModal()});
document.querySelector('[data-action="refresh"]').addEventListener('click',e=>{e.currentTarget.textContent='✓';setTimeout(()=>e.currentTarget.textContent='↻',1000)});
bindCards();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
}
