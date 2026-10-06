
// 이 경고만 네이티브 alert을 유지한다. 앱이 정상 구동되지 않는 상황을 알리는 것이라
// 앱의 모달(showAlert)에 의존시키지 않는다.
if (window.location.protocol === 'file:') {
  alert('이 페이지는 서버를 통해 실행해야 합니다. 터미널에서 서버를 실행한 뒤 (예: npm start) 브라우저에서 http://localhost:12345 (또는 설정한 포트)로 접속해주세요.');
}

/* ---- 무거운 라이브러리 지연 로드 ---- */
// 초기 렌더/로그인 속도를 위해 head에서 제거하고, 실제 사용 시점에만 1회 로드한다.
const CDN = {
  xlsx: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
  jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  filesaver: 'https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js',
};
const _scriptCache = {};
function loadScriptOnce(url) {
  if (_scriptCache[url]) return _scriptCache[url];
  _scriptCache[url] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { delete _scriptCache[url]; reject(new Error('스크립트 로드 실패: ' + url)); };
    document.head.appendChild(s);
  });
  return _scriptCache[url];
}

const themeBtn = document.getElementById('themeToggleBtn');
const moonSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
const sunSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;

const rootEl = document.documentElement;
// 기본값은 라이트모드. 사용자가 직접 다크모드를 선택했을 때만 .theme-dark 적용
function effectiveDark(){
  return rootEl.classList.contains('theme-dark');
}
function updateThemeIcon(){ themeBtn.innerHTML = effectiveDark() ? sunSvg : moonSvg; }
updateThemeIcon();
themeBtn.onclick = () => {
  const goDark = !effectiveDark();
  rootEl.classList.toggle('theme-dark', goDark);
  localStorage.setItem('expense_theme', goDark ? 'dark' : 'light');
  updateThemeIcon();
};

function setLoading(btn, isLoading, text) {
  if (isLoading) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${text}`;
  } else {
    btn.disabled = false;
    btn.textContent = text;
  }
}

const STORAGE_KEY='expense_ledger_v4';
// 영수증 원본 이미지 보관 기간(해당 월 종료일 기준). server.js의 RETENTION_DAYS와 반드시 동일하게 유지한다.
const RETENTION_DAYS = 90;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
// 휴지통 보관 기간. server.js의 TRASH_DAYS와 반드시 동일하게 유지한다.
const TRASH_DAYS = 30;
const won=n=>Number(n||0).toLocaleString('ko-KR');
const pad=n=>String(n).padStart(2,'0');
// 저장형 XSS 방지: innerHTML 템플릿에 사용자 입력을 넣기 전 HTML 특수문자를 이스케이프한다.
const escapeHtml=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ymd=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

// 첨부 이미지 기준 자동추천 옵션
const ACCOUNTS=['(판)여비교통비-(시내교통비)','(판)여비교통비-(국내출장비)','미지급금-(직원경비)','(판)복리후생비','(판)소모품비','(판)지급수수료','(판)광고선전비','(판)접대비'];
// 사용처가 비어있을 때 다운로드 파일명에 쓸 계정과목 → 라벨 매핑
const ACCOUNT_LABEL={'(판)여비교통비-(시내교통비)':'교통비','(판)여비교통비-(국내출장비)':'숙박비','(판)복리후생비':'식대','(판)소모품비':'소모품','(판)지급수수료':'수수료','(판)광고선전비':'광고선전비','(판)접대비':'접대비','미지급금-(직원경비)':'직원경비'};

// 출장비 전표: 거래처는 회사(코나아이)로 고정하고 증빙란은 비워둔다.
const TRIP_ACCOUNT='(판)여비교통비-(국내출장비)';
const COMPANY_VENDOR='코나아이';
const PROOF_PERSONAL_CARD='지출증빙_개인카드';
const isTripExpense=e=>e.account===TRIP_ACCOUNT||String(e.memo||'').includes('출장비');

// 미지급금 적요: 해당 월의 경비 종류를 나열한다. 예) "9월 출장, 교통비 경비"
function payableMemo(month,rows){
  const labels=[];
  rows.forEach(e=>{
    const l=isTripExpense(e)?'출장':(ACCOUNT_LABEL[e.account]||e.account);
    if(!labels.includes(l))labels.push(l);
  });
  const i=labels.indexOf('출장');
  if(i>0)labels.unshift(...labels.splice(i,1));
  return `${month}월 ${labels.join(', ')} 경비`;
}

// 초기 시드 데이터
const SEED=[];

let entries=[];
let viewDate=new Date(); // 현재 달
let dayDate=null;        // 상세 모달에 표시 중인 날짜
let editingId=null;
let pendingReceiptImageId=null; // 영수증 이미지 임시 ID

/* ---- 하이브리드 인증 및 API 유틸리티 ---- */
function isLoggedIn() {
  return !!localStorage.getItem('expense_user_token');
}

function getHeaders() {
  const token = localStorage.getItem('expense_user_token');
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

let sessionExpired = false;
function clearAuthStorage() {
  localStorage.removeItem('expense_user_token');
  localStorage.removeItem('expense_user_email');
  localStorage.removeItem('expense_user_name');
  localStorage.removeItem('expense_user_team');
}
async function loadEntries() {
  sessionExpired = false;
  if (isLoggedIn()) {
    try {
      const res = await fetch('/api/expenses', { headers: getHeaders() });
      if (res.ok) {
        entries = await res.json();
        return;
      }
      // 토큰 만료/무효화(401·403): 로그인된 것처럼 보이지만 서버 데이터를 못 불러오는 상태.
      // 조용히 게스트 데이터로 폴백하면 "로그인됐는데 전표가 안 보임"이 되므로, 세션을 정리하고 재로그인을 유도한다.
      if (res.status === 401 || res.status === 403) {
        clearAuthStorage();
        sessionExpired = true;
      }
    } catch(e) {
      console.error('서버 데이터 로드 실패, 로컬 임시 데이터 사용:', e.message);
    }
  }
  // 게스트 모드
  try {
    const r=localStorage.getItem(STORAGE_KEY);
    if(r){
      entries = JSON.parse(r);
      return;
    }
  } catch(e){}
  
  entries = SEED.map((s,i)=>({id:Date.now()+i,...s}));
  try{localStorage.setItem(STORAGE_KEY,JSON.stringify(entries));}catch(e){}
}

let saveTimer;

function setIconBtnLoading(btn, loading) {
  if (loading) {
    btn.classList.add('btn-loading');
    btn.disabled = true;
  } else {
    btn.classList.remove('btn-loading');
    btn.disabled = false;
  }
}

function flashSave(text = '저장됨') {
  const el=document.getElementById('saveState');
  el.textContent=text;
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>el.textContent='저장됨',1000);
}

/* ---- populate selects ---- */
function fillSelect(el,arr,blank){
  el.innerHTML=(blank?`<option value="">${blank}</option>`:'')+arr.map(a=>`<option>${a}</option>`).join('');
}
fillSelect(document.getElementById('fAccount'),ACCOUNTS);

// 적요 키워드 → 계정과목 자동추천
const CITY_KW=['교통','택시','기차','버스'];
const TRIP_KW=['숙박','출장비'];
function suggestAccount(){
  const memo=document.getElementById('fMemo').value;
  const tag=document.getElementById('autoTag');
  let acc=null;
  if(TRIP_KW.some(k=>memo.includes(k)))acc='(판)여비교통비-(국내출장비)';
  else if(CITY_KW.some(k=>memo.includes(k)))acc='(판)여비교통비-(시내교통비)';
  if(acc){
    document.getElementById('fAccount').value=acc;
    tag.textContent='· 자동 선택됨';
    setTimeout(()=>{tag.textContent='';},1500);
  }
}
document.getElementById('fMemo').addEventListener('input',suggestAccount);

// 금액 입력 천단위 콤마 자동 생성
const fDebitEl=document.getElementById('fDebit');
fDebitEl.addEventListener('input',()=>{
  const raw=fDebitEl.value.replace(/[^0-9]/g,'');
  fDebitEl.value=raw?Number(raw).toLocaleString('ko-KR'):'';
});
const numVal=el=>Number(el.value.replace(/[^0-9]/g,'')||0);

// 입력하면 해당 칸 누락 강조 해제
['fDate','fMemo','fAccount','fDebit'].forEach(id=>{
  const el=document.getElementById(id);
  const ev=el.tagName==='SELECT'?'change':'input';
  el.addEventListener(ev,()=>el.closest('.field').classList.remove('invalid'));
});

/* ---- calendar ---- */
const DOW=['일','월','화','수','목','금','토'];
(function(){
  document.getElementById('dowRow').innerHTML=DOW.map((d,i)=>
    `<div class="dow ${i===0?'sun':''} ${i===6?'sat':''}">${d}</div>`).join('');
})();

function dayTotals(dateStr){
  let d=0,c=0,has=false;
  entries.forEach(e=>{if(e.date===dateStr){has=true;d+=Number(e.debit||0);c+=Number(e.credit||0);}});
  return {d,c,has};
}

function renderCalendar(){
  const y=viewDate.getFullYear(),m=viewDate.getMonth();
  document.getElementById('calTitle').textContent=`${y}년 ${m+1}월`;
  const first=new Date(y,m,1).getDay();
  const days=new Date(y,m+1,0).getDate();
  const todayStr=ymd(new Date());
  let html='';
  for(let i=0;i<first;i++)html+='<div class="day empty"></div>';
  for(let dnum=1;dnum<=days;dnum++){
    const ds=`${y}-${pad(m+1)}-${pad(dnum)}`;
    const dow=new Date(y,m,dnum).getDay();
    const t=dayTotals(ds);
    const cls=['day'];
    if(dow===0)cls.push('sun');if(dow===6)cls.push('sat');
    if(ds===todayStr)cls.push('today');
    let amt='';
    if(t.has){
      cls.push('has-amt');
      amt=`<div>${won(t.d+t.c)}</div>`;
    }
    html+=`<div class="${cls.join(' ')}" data-date="${ds}">
      ${t.has?'<span class="dot"></span>':''}
      <span class="num">${dnum}</span>
      <span class="amt">${amt}</span></div>`;
  }
  document.getElementById('calGrid').innerHTML=html;
  document.querySelectorAll('.day:not(.empty)').forEach(el=>{
    el.addEventListener('click',()=>{
      const ds=el.dataset.date;
      if(entries.some(e=>e.date===ds))openDayModal(ds);
      else openAddForDate(ds);
    });
  });
}

/* ---- list ---- */
function monthStr(){return `${viewDate.getFullYear()}-${pad(viewDate.getMonth()+1)}`;}
function filtered(){
  const ms=monthStr();
  return entries.filter(e=>e.date.startsWith(ms))
    .sort((a,b)=>a.date.localeCompare(b.date)||a.id-b.id);
}

let currentReceiptViewId = null;
function resetReceiptViewer() {
  const viewer = document.getElementById('receiptViewerContent');
  if (!viewer) return;
  currentReceiptViewId = null;
  viewer.innerHTML = `
    <div class="receipt-placeholder">
      <div style="font-size: 32px; margin-bottom: 12px;">📄</div>
      좌측 리스트에서 전표를 선택하거나<br>영수증을 스캔하면 원본이 표시됩니다.
    </div>
  `;
}
async function showReceiptInViewer(id) {
  const viewer = document.getElementById('receiptViewerContent');
  if (!viewer) return;
  currentReceiptViewId = id;
  viewer.innerHTML = `
    <div class="receipt-placeholder" style="display:flex;flex-direction:column;align-items:center;gap:10px;">
      <div class="spinner" style="width:22px;height:22px;border-width:3px;border-color:var(--blue);border-top-color:transparent;margin:0;"></div>
      <span>이미지 불러오는 중...</span>
    </div>
  `;
  try {
    const dataUrl = await getImage(id);
    if (dataUrl) {
      viewer.innerHTML = `<img src="${dataUrl}" alt="영수증 원본">`;
      const img = viewer.querySelector('img');
      if (img) img.onclick = () => window.openZoom(dataUrl);
    } else {
      viewer.innerHTML = `
        <div class="receipt-placeholder">
          <div style="font-size: 32px; margin-bottom: 12px;">📄</div>
          이 전표에는 저장된 영수증 이미지가 없습니다.
        </div>
      `;
    }
  } catch(e) {
    viewer.innerHTML = `
      <div class="receipt-placeholder">
        <div style="font-size: 32px; margin-bottom: 12px;">⚠️</div>
        이미지를 불러오는데 실패했습니다.
      </div>
    `;
  }
}

function renderList(){
  const rows=filtered();
  const y=viewDate.getFullYear(),m=viewDate.getMonth()+1;
  const label=`${String(y).slice(2)}년 ${m}월`;

  const td=rows.reduce((s,e)=>s+Number(e.debit||0),0);

  // === ERP 뷰 ===
  const tbodyErp=document.getElementById('tbodyErp');
  const tfootErp=document.getElementById('tfootErp');
  const emptyErp=document.getElementById('emptyStateErp');
  document.getElementById('listMonthLabel').textContent=label;
  document.getElementById('listCountErp').textContent=`${rows.length}건`;
  
  const lastDay = new Date(y, viewDate.getMonth() + 1, 0).getDate();
  document.getElementById('erpAccountingDate').textContent = `${y}.${String(m).padStart(2, '0')}.${String(lastDay).padStart(2, '0')}`;

  if(rows.length===0){
    tbodyErp.innerHTML=''; tfootErp.innerHTML=''; emptyErp.style.display='block';
  } else {
    emptyErp.style.display='none';
    tbodyErp.innerHTML=rows.map((e,i)=>{
      const dArr = e.date.split('-');
      const memoStr = `${dArr[0].slice(2)}.${dArr[1]}.${dArr[2]} ${e.memo||''}`.trim();
      return `
      <tr class="row erp-row" data-id="${e.id}" style="cursor: pointer;">
        <td class="muted">${String(i+1).padStart(4, '0')}</td>
        <td>${escapeHtml(e.account)}</td>
        <td class="r debit">${e.debit?won(e.debit):'<span class="muted">0</span>'}</td>
        <td class="r credit">${e.credit?won(e.credit):'<span class="muted">0</span>'}</td>
        <td style="white-space:normal" class="muted">${escapeHtml(memoStr)}</td>
        <td class="sticky-col" style="vertical-align: middle;"><div class="row-act" style="justify-content: center; width: 100%;">
          <button class="icon-btn" data-edit="${e.id}" title="수정" onclick="event.stopPropagation();">✎</button>
          <button class="icon-btn del" data-del="${e.id}" title="삭제" onclick="event.stopPropagation();">✕</button>
        </div></td>
      </tr>`;
    }).join('');
    tfootErp.innerHTML=`<tr class="erp-total-row" style="cursor:pointer;">
      <td class="muted">${String(rows.length+1).padStart(4, '0')}</td>
      <td class="lbl">미지급금-(직원경비)</td>
      <td class="r muted"></td>
      <td class="r" style="color:var(--credit)">${won(td)}</td>
      <td style="white-space:normal" class="muted">${escapeHtml(payableMemo(m,rows))}</td>
      <td class="sticky-col"></td>
    </tr>`;

    const totalRow = tfootErp.querySelector('.erp-total-row');
    
    tbodyErp.querySelectorAll('.erp-row').forEach(row => {
      row.onclick = () => {
        tbodyErp.querySelectorAll('.erp-row').forEach(r => r.style.background = '');
        if(totalRow) totalRow.style.background = '';
        row.style.background = 'var(--blue-soft)';
        const id = row.dataset.id;
        const e = entries.find(x => String(x.id) === String(id));
        if (e) {
          const trip = isTripExpense(e);
          document.getElementById('previewVendor').value = trip ? COMPANY_VENDOR : (e.vendor || '');
          document.getElementById('previewName').value = e.employeeName || (isLoggedIn() ? (localStorage.getItem('expense_user_name') || '사원명 입력') : '사원명 입력');
          const pf = document.getElementById('previewProof');
          if(pf) pf.value = trip ? '' : PROOF_PERSONAL_CARD;
        }
        showReceiptInViewer(id);
      };
    });

    if(totalRow) {
      totalRow.onclick = () => {
        tbodyErp.querySelectorAll('.erp-row').forEach(r => r.style.background = '');
        totalRow.style.background = 'var(--blue-soft)';
        
        // 미지급금 클릭 시 하단 박스 항목 변경
        const userName = isLoggedIn() ? (localStorage.getItem('expense_user_name') || '사원명 입력') : '사원명 입력';
        document.getElementById('previewVendor').value = '코나아이';
        document.getElementById('previewName').value = userName;
        const pf = document.getElementById('previewProof');
        if(pf) pf.value = ''; // 증빙 없음
        
        resetReceiptViewer();
      };
    }
  }



  // Bind edit/delete for all lists
  document.querySelectorAll('[data-del]').forEach(b=>b.onclick=(ev)=>{
    askDelete(ev.currentTarget.dataset.del);
  });
  document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=(ev)=>{
    startEdit(ev.currentTarget.dataset.edit);
  });
}

/* ---- 휴지통 + 삭제 되돌리기 ----
   삭제는 즉시 파기가 아니라 휴지통 이동이다. 회원은 서버 deleted_at,
   게스트는 TRASH_KEY(localStorage)에 보관하고 영수증 이미지는 그대로 남긴다.
   되돌리기 토스트는 '방금 실수'용 빠른 경로일 뿐이고, 시간이 지난 뒤에는
   휴지통에서 TRASH_DAYS 동안 복원할 수 있다. */
const TRASH_KEY = 'expense_trash_v1';
const UNDO_WINDOW_MS = 10000;
let undoSnapshot = null;   // 되돌릴 전표 id 목록 (실제 데이터는 휴지통에 있다)
let undoHideTimer = null;

function loadTrash(){
  try { const r = localStorage.getItem(TRASH_KEY); return r ? JSON.parse(r) : []; }
  catch(e){ return []; }
}
function saveTrash(list){
  try { localStorage.setItem(TRASH_KEY, JSON.stringify(list)); } catch(e){ console.error(e.message); }
}

// 남은 보관 일수 (0이면 오늘 파기 예정)
function trashDaysLeft(deletedAt){
  const t = new Date(String(deletedAt).replace(' ', 'T') + (String(deletedAt).endsWith('Z') ? '' : 'Z')).getTime();
  if(isNaN(t)) return TRASH_DAYS;
  return Math.max(0, TRASH_DAYS - Math.floor((Date.now() - t) / 86400000));
}

// 게스트 휴지통에서 보관 기간이 지난 항목을 영구 파기한다 (회원은 서버가 처리)
async function purgeGuestTrash(){
  if(isLoggedIn()) return;
  const list = loadTrash();
  const keep = [], drop = [];
  list.forEach(it => (trashDaysLeft(it.deletedAt) > 0 ? keep : drop).push(it));
  if(drop.length === 0) return;
  for(const it of drop){ try { await deleteImage(it.id); } catch(e){} }
  saveTrash(keep);
  console.log(`🗑️ 휴지통 영구 파기: ${TRASH_DAYS}일 경과 전표 ${drop.length}건`);
}

// 게스트 → 회원 전환 시 게스트 휴지통을 정리한다. 로그인 후에는 서버 휴지통을
// 보므로 남겨두면 화면에서 접근할 수 없는 잔여 데이터가 된다.
async function discardGuestTrash(){
  const list = loadTrash();
  for(const it of list){ try { await deleteImage(it.id); } catch(e){} }
  try { localStorage.removeItem(TRASH_KEY); } catch(e){}
}

async function fetchTrash(){
  if(isLoggedIn()){
    try {
      const res = await fetch('/api/expenses/trash', { headers: getHeaders() });
      if(res.ok) return await res.json();
    } catch(e){ console.error(e.message); }
    return [];
  }
  return loadTrash().slice().sort((a,b)=>String(b.deletedAt).localeCompare(String(a.deletedAt)));
}

// 전표를 휴지통으로 보낸다. 영수증 이미지는 지우지 않는다(복원 대비).
async function moveToTrash(rows){
  const ids = rows.map(r => String(r.id));
  if(isLoggedIn()){
    const res = await fetch('/api/expenses/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getHeaders() },
      body: JSON.stringify({ ids })
    });
    if(!res.ok){
      const err = await res.json().catch(()=>({}));
      throw new Error(err.error || '삭제 실패');
    }
  } else {
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const trash = loadTrash();
    rows.forEach(r => trash.push({ ...r, deletedAt: stamp }));
    saveTrash(trash);
  }
  entries = entries.filter(x => !ids.includes(String(x.id)));
  if(!isLoggedIn()) localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  return ids;
}

// 휴지통에서 복원한다. id와 영수증이 그대로라 원래 상태로 돌아간다.
async function restoreFromTrash(ids){
  let restored = 0, failed = 0;
  if(isLoggedIn()){
    try {
      const res = await fetch('/api/expenses/bulk-restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getHeaders() },
        body: JSON.stringify({ ids })
      });
      if(res.ok){
        const data = await res.json();
        data.restored.forEach(e => entries.push(e));
        restored = data.restored.length;
      }
    } catch(err){ console.error(err.message); }
    // 보관 기간이 지나 파기된 건은 복원되지 않는다.
    failed = ids.length - restored;
  } else {
    const trash = loadTrash(), keep = [];
    trash.forEach(it => {
      if(ids.includes(String(it.id))){
        const { deletedAt, ...entry } = it;
        entries.push(entry);
        restored++;
      } else keep.push(it);
    });
    failed = ids.length - restored;
    saveTrash(keep);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  }
  renderAll();
  if(document.getElementById('dayOverlay').classList.contains('open')) renderDayModal();
  return { restored, failed };
}

// 휴지통에서 영구 삭제 (영수증 이미지까지)
async function purgeFromTrash(ids){
  if(isLoggedIn()){
    try {
      await fetch('/api/expenses/bulk-purge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getHeaders() },
        body: JSON.stringify({ ids })
      });
    } catch(err){ console.error(err.message); }
  } else {
    saveTrash(loadTrash().filter(it => !ids.includes(String(it.id))));
  }
  for(const id of ids){ try { await deleteImage(id); } catch(e){} }
}

/* ---- 되돌리기 토스트 ---- */
function showUndoToast(ids){
  if(!ids || ids.length === 0) return;
  undoSnapshot = ids;
  document.getElementById('undoToastText').textContent =
    ids.length > 1 ? `전표 ${ids.length}건을 휴지통으로 옮겼습니다.` : '전표를 휴지통으로 옮겼습니다.';
  const btn = document.getElementById('undoBtn');
  btn.disabled = false;
  btn.textContent = '되돌리기';
  document.getElementById('undoToast').classList.add('open');
  clearTimeout(undoHideTimer);
  undoHideTimer = setTimeout(hideUndoToast, UNDO_WINDOW_MS);
}

function hideUndoToast(){
  clearTimeout(undoHideTimer);
  undoSnapshot = null;
  document.getElementById('undoToast').classList.remove('open');
}

async function undoDelete(){
  if(!undoSnapshot) return;
  const ids = undoSnapshot;
  const btn = document.getElementById('undoBtn');
  btn.disabled = true;
  btn.textContent = '복원 중...';
  clearTimeout(undoHideTimer);
  try {
    const { restored, failed } = await restoreFromTrash(ids);
    flashSave(failed ? '일부 복원 실패' : '복원됨');
    if(failed) await showAlert(`${restored}건을 복원했지만 ${failed}건은 복원하지 못했습니다.`);
  } finally {
    hideUndoToast();
  }
}
document.getElementById('undoBtn').onclick = undoDelete;

/* ---- 휴지통 화면 ---- */
async function openTrash(){
  document.getElementById('trashOverlay').classList.add('open');
  await renderTrash();
}
function closeTrash(){
  document.getElementById('trashOverlay').classList.remove('open');
}

async function renderTrash(){
  const body = document.getElementById('trashBody');
  const emptyBtn = document.getElementById('trashEmptyBtn');
  body.innerHTML = '<div class="trash-empty">불러오는 중…</div>';
  const list = await fetchTrash();
  document.getElementById('trashCountText').textContent = `${list.length}건`;
  emptyBtn.style.display = list.length ? '' : 'none';

  if(list.length === 0){
    body.innerHTML = `<div class="trash-empty">휴지통이 비어 있습니다.<br><span class="muted">삭제한 전표는 ${TRASH_DAYS}일간 여기 보관됩니다.</span></div>`;
    return;
  }

  body.innerHTML = list.map(it => {
    const left = trashDaysLeft(it.deletedAt);
    const label = it.vendor || ACCOUNT_LABEL[it.account] || it.account;
    return `
    <div class="trash-item">
      <div class="trash-info">
        <div class="trash-title">${escapeHtml(it.date)} · ${escapeHtml(label)}</div>
        <div class="trash-sub">${won(it.debit)}원 · ${escapeHtml(it.memo || '')}</div>
        <div class="trash-left">${left === 0 ? '오늘 파기 예정' : `${left}일 후 파기`}</div>
      </div>
      <div class="trash-act">
        <button class="btn btn-primary trash-restore" data-restore="${it.id}" style="height:34px;padding:0 14px;font-size:13px;">복원</button>
        <button class="btn btn-ghost trash-purge" data-purge="${it.id}" style="height:34px;padding:0 12px;font-size:13px;color:var(--credit);">영구삭제</button>
      </div>
    </div>`;
  }).join('');

  body.querySelectorAll('[data-restore]').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = '복원 중';
    const { failed } = await restoreFromTrash([String(b.dataset.restore)]);
    flashSave(failed ? '복원 실패' : '복원됨');
    await renderTrash();
  });
  body.querySelectorAll('[data-purge]').forEach(b => b.onclick = async () => {
    if(!await showConfirm('이 전표와 영수증을 영구 삭제할까요? 이 작업은 되돌릴 수 없습니다.', { okText: '영구삭제', danger: true })) return;
    b.disabled = true;
    await purgeFromTrash([String(b.dataset.purge)]);
    flashSave('영구 삭제됨');
    await renderTrash();
  });
}

document.getElementById('trashBtn').onclick = openTrash;
document.getElementById('trashCloseBtn').onclick = closeTrash;
document.getElementById('trashOverlay').addEventListener('click', e => {
  if(e.target.id === 'trashOverlay') closeTrash();
});
document.getElementById('trashEmptyBtn').onclick = async () => {
  const list = await fetchTrash();
  if(list.length === 0) return;
  if(!await showConfirm(`휴지통의 전표 ${list.length}건과 영수증을 모두 영구 삭제할까요? 이 작업은 되돌릴 수 없습니다.`, { okText: '비우기', danger: true })) return;
  await purgeFromTrash(list.map(it => String(it.id)));
  flashSave('휴지통을 비웠습니다');
  await renderTrash();
};

/* ---- add / edit ---- */
let pendingDeleteId=null;
function askDelete(id){
  const e=entries.find(x=>String(x.id)===String(id));
  pendingDeleteId=id;
  document.getElementById('confirmMemo').textContent=e?(e.memo||e.account):'';
  document.getElementById('confirmOverlay').classList.add('open');
}
function closeConfirm(){
  pendingDeleteId=null;
  document.getElementById('confirmOverlay').classList.remove('open');
}
document.getElementById('confirmCancel').onclick=closeConfirm;
document.getElementById('confirmDelete').onclick=async()=>{
  if(pendingDeleteId!=null){
    const confirmBtn = document.getElementById('confirmDelete');
    const target = entries.find(x => String(x.id) === String(pendingDeleteId));
    if(!target){ closeConfirm(); return; }
    setIconBtnLoading(confirmBtn, true);
    flashSave('삭제 중…');
    try {
      // 즉시 파기가 아니라 휴지통으로 옮긴다. 영수증 이미지는 복원을 위해 남겨둔다.
      const ids = await moveToTrash([target]);
      flashSave('휴지통으로 이동');
      renderAll();
      if (document.getElementById('dayOverlay').classList.contains('open')) renderDayModal();
      if (String(currentReceiptViewId) === String(pendingDeleteId)) resetReceiptViewer();
      showUndoToast(ids);
      closeConfirm();
    } catch (err) {
      console.error(err.message);
      await showAlert(`삭제 실패: ${err.message}`);
      flashSave('삭제 실패');
      closeConfirm();
    } finally {
      setIconBtnLoading(confirmBtn, false);
    }
  }
};

document.getElementById('deleteAllBtn').onclick = async () => {
  const rows = filtered();
  if (rows.length === 0) { await showAlert('삭제할 전표가 없습니다.'); return; }
  const y = viewDate.getFullYear();
  const m = viewDate.getMonth() + 1;
  if (!await showConfirm(`현재 월(${y}년 ${m}월)의 전표 ${rows.length}건을 모두 휴지통으로 옮기시겠습니까? 휴지통에서 ${TRASH_DAYS}일간 복원할 수 있습니다.`, { okText: '휴지통으로', danger: true })) return;

  const deleteAllBtn = document.getElementById('deleteAllBtn');
  setIconBtnLoading(deleteAllBtn, true);
  flashSave('휴지통으로 이동 중...');

  try {
    const ids = await moveToTrash(rows);
    flashSave('휴지통으로 이동');
    resetReceiptViewer();
    renderAll();
    showUndoToast(ids);
  } catch (err) {
    console.error(err);
    await showAlert('삭제 중 오류가 발생했습니다.');
  } finally {
    setIconBtnLoading(deleteAllBtn, false);
  }
};
document.getElementById('confirmOverlay').addEventListener('click',e=>{
  if(e.target.id==='confirmOverlay')closeConfirm();
});
function openModal(){
  document.getElementById('overlay').classList.add('open');
  setTimeout(()=>document.getElementById('fMemo').focus(),60);
}
function closeModal(){
  document.getElementById('overlay').classList.remove('open');
  resetForm();
}

function newEntry(){
  resetForm();
  document.getElementById('fDate').value=ymd(new Date());
  openModal();
}

// 특정 날짜로 입력 폼 바로 열기
function openAddForDate(ds){
  resetForm();
  document.getElementById('fDate').value=ds;
  openModal();
}

/* ---- day detail modal ---- */
function openDayModal(ds){
  dayDate=ds;
  renderDayModal();
  document.getElementById('dayOverlay').classList.add('open');
}
function closeDayModal(){
  document.getElementById('dayOverlay').classList.remove('open');
  dayDate=null;
}
function renderDayModal(){
  if(!dayDate)return;
  const [y,m,d]=dayDate.split('-').map(Number);
  document.getElementById('dayTitle').textContent=`${y}년 ${m}월 ${d}일`;
  const rows=entries.filter(e=>e.date===dayDate).sort((a,b)=>a.id-b.id);
  const list=document.getElementById('dayList');
  if(rows.length===0){
    list.innerHTML='<div class="day-empty">아직 등록된 전표가 없습니다.<br>위 버튼으로 추가하세요.</div>';
    return;
  }
  const total=rows.reduce((s,e)=>s+Number(e.debit||0),0);
  list.innerHTML=rows.map(e=>`
    <div class="dayrow">
      <div class="info">
        <div class="acc">${escapeHtml(e.account)}</div>
        <div class="memo">${escapeHtml(e.memo||'')}${e.vendor?` · ${escapeHtml(e.vendor)}`:''}</div>
      </div>
      <div class="amt2">${won(e.debit)}</div>
      <div class="acts">
        <button class="icon-btn" data-dedit="${e.id}" title="수정">✎</button>
        <button class="icon-btn del" data-ddel="${e.id}" title="삭제">✕</button>
      </div>
    </div>`).join('')
    +`<div class="day-total"><span>합계 · 미지급금-(직원경비)</span><span class="v">${won(total)}</span></div>`;
  list.querySelectorAll('[data-dedit]').forEach(b=>b.onclick=ev=>{
    document.getElementById('dayOverlay').classList.remove('open');
    startEdit(ev.currentTarget.dataset.dedit);
  });
  list.querySelectorAll('[data-ddel]').forEach(b=>b.onclick=ev=>askDelete(ev.currentTarget.dataset.ddel));
}
document.getElementById('dayAddBtn').onclick=()=>{
  if(!dayDate)return;
  document.getElementById('dayOverlay').classList.remove('open');
  openAddForDate(dayDate);
};
document.getElementById('closeDay').onclick=closeDayModal;
document.getElementById('dayOverlay').addEventListener('click',e=>{if(e.target.id==='dayOverlay')closeDayModal();});

function startEdit(id){
  const e=entries.find(x=>x.id==id);if(!e)return;
  editingId=id;
  document.getElementById('fDate').value=e.date;
  document.getElementById('fAccount').value=e.account;
  document.getElementById('fDebit').value=e.debit?Number(e.debit).toLocaleString('ko-KR'):'';
  document.getElementById('fMemo').value=e.memo||'';
  document.getElementById('fVendor').value=e.vendor||'';
  document.getElementById('addTitle').textContent='전표 수정';
  document.getElementById('addBtn').textContent='수정 저장';
  document.getElementById('addContinueBtn').style.display='none';
  openModal();
}

function clearErrors(){
  document.querySelectorAll('.field.invalid').forEach(f=>f.classList.remove('invalid'));
}

function resetForm(){
  editingId=null;
  ['fDebit','fMemo','fVendor'].forEach(id=>document.getElementById(id).value='');
  clearErrors();
  document.getElementById('addTitle').textContent='새 전표 추가';
  document.getElementById('addBtn').textContent='전표 추가';
  document.getElementById('addContinueBtn').style.display='';
  document.getElementById('fDate').value=ymd(new Date());
}

async function submitEntry(){
  clearErrors();
  const date=document.getElementById('fDate').value;
  const account=document.getElementById('fAccount').value;
  const debit=numVal(document.getElementById('fDebit'));
  const memo=document.getElementById('fMemo').value.trim();

  // 필수 항목 검증
  const checks=[
    [!date,'fDate'],
    [!memo,'fMemo'],
    [!account,'fAccount'],
    [!debit,'fDebit'],
  ];
  let firstBad=null;
  checks.forEach(([bad,id])=>{
    if(bad){
      const f=document.getElementById(id).closest('.field');
      f.classList.add('invalid');
      if(!firstBad)firstBad=document.getElementById(id);
    }
  });
  if(firstBad){firstBad.focus();return false;}

  const data={
    date,account,
    debit,credit:0,
    memo,
    vendor:document.getElementById('fVendor').value.trim(),
    department: '',
    employeeName: isLoggedIn() ? (localStorage.getItem('expense_user_name') || '') : '사원명 입력',
  };

  flashSave('저장 중…');

  if (isLoggedIn()) {
    try {
      let res;
      if (editingId) {
        res = await fetch(`/api/expenses/${editingId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...getHeaders() },
          body: JSON.stringify(data)
        });
      } else {
        res = await fetch('/api/expenses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getHeaders() },
          body: JSON.stringify(data)
        });
      }
      
      if (res.ok) {
        const saved = await res.json();
        if (editingId) {
          const idx = entries.findIndex(x => x.id == editingId);
          if (idx !== -1) entries[idx] = saved;
        } else {
          entries.push(saved);
          // 영수증 이미지 ID 리네임 매칭
          if (pendingReceiptImageId) {
            await renameImage(pendingReceiptImageId, saved.id);
            pendingReceiptImageId = null;
          }
        }
        flashSave('저장됨');
      } else {
        const errData = await res.json();
        await showAlert(`저장 실패: ${errData.error || '알 수 없는 오류'}`);
        flashSave('저장 실패');
        return false;
      }
    } catch (err) {
      console.error(err.message);
      await showAlert('서버 통신 오류가 발생했습니다.');
      flashSave('저장 실패');
      return false;
    }
  } else {
    // 게스트 모드
    if(editingId){
      const e=entries.find(x=>x.id==editingId);Object.assign(e,data);
    }else{
      const newLocalId = Date.now();
      entries.push({id:newLocalId,...data});
      if (pendingReceiptImageId) {
        await renameImage(pendingReceiptImageId, newLocalId);
        pendingReceiptImageId = null;
      }
    }
    localStorage.setItem(STORAGE_KEY,JSON.stringify(entries));
    flashSave('저장됨');
  }

  renderAll();
  return true;
}

/* 저장 중 재클릭 방지.
   서버 응답이 늦으면(무료 플랜 콜드 스타트 등) 사용자가 한 번 더 누르기 쉬운데,
   그러면 같은 전표가 두 건 등록되고 pendingReceiptImageId를 두 호출이 함께 읽어
   영수증이 한쪽에만 붙는다. 삭제·내보내기·인증 핸들러와 같은 방식으로 잠근다. */
let savingEntry=false;
async function runSubmit(pressedBtn, onSuccess){
  if(savingEntry)return;
  savingEntry=true;
  const addBtn=document.getElementById('addBtn');
  const contBtn=document.getElementById('addContinueBtn');
  // 라벨은 편집 여부에 따라 바뀌므로(전표 추가 / 수정 저장) 눌린 시점 값을 되돌린다.
  const addLabel=addBtn.textContent, contLabel=contBtn.textContent;
  setLoading(pressedBtn,true,pressedBtn.textContent);
  addBtn.disabled=true; contBtn.disabled=true;   // 두 버튼을 함께 잠가야 우회가 없다
  try{
    if(await submitEntry()) onSuccess();
  }finally{
    savingEntry=false;
    setLoading(addBtn,false,addLabel);
    setLoading(contBtn,false,contLabel);
  }
}

document.getElementById('addBtn').onclick=async()=>{
  await runSubmit(document.getElementById('addBtn'), closeModal);
};

document.getElementById('addContinueBtn').onclick=async()=>{
  if(editingId)return;
  await runSubmit(document.getElementById('addContinueBtn'), ()=>{
    const keepDate=document.getElementById('fDate').value;
    resetForm();
    document.getElementById('fDate').value=keepDate;
    const hint=document.getElementById('addHint');
    hint.textContent='추가됨 · 계속 입력하세요';
    setTimeout(()=>{hint.textContent='';},1500);
    document.getElementById('fMemo').focus();
  });
};
document.getElementById('closeModal').onclick=closeModal;

/* 내보내기 단일 버튼 (드롭다운 삭제됨) */
document.getElementById('overlay').addEventListener('click',e=>{if(e.target.id==='overlay')closeModal();});
document.getElementById('overlay').addEventListener('keydown',e=>{
  if(e.key==='Enter'){e.preventDefault();document.getElementById('addBtn').click();}
});

/* ---- 영수증 자동 입력 (Tesseract.js OCR) ---- */
function parseReceipt(text){
  const lines=text.split('\n').map(l=>l.trim()).filter(Boolean);
  const result={date:'',amount:0,vendor:'',memo:''};

  // ---- 날짜: 거래/승인 일시 키워드가 있는 줄을 우선 (두 자리 우선 매칭으로 일(日) 오인식 방지) ----
  const dateRe=/(20\d{2}|\d{2})\s*[.\/\-년]\s*(1[0-2]|0?[1-9])\s*[.\/\-월]\s*(3[01]|[12]\d|0?[1-9])\s*일?/;
  const dateKw=/(거\s*래\s*일|승\s*인\s*일|결\s*제\s*일|판\s*매\s*일|이\s*용\s*일|일\s*시|날\s*짜)/;
  const normDate=m=>{let y=Number(m[1]);if(y<100)y+=2000;return `${y}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;};
  for(const l of lines){ if(dateKw.test(l)){ const m=l.match(dateRe); if(m){ result.date=normDate(m); break; } } }
  if(!result.date){ for(const l of lines){ const m=l.match(dateRe); if(m){ result.date=normDate(m); break; } } }
  if(!result.date)result.date=ymd(new Date());

  // ---- 금액: '천단위 구분(콤마/점)이 있는 숫자(16,900·16.900)'를 핵심 신호로. OCR이 '원'을 '뭔/8'로 깨먹어도 인식 ----
  const strongKw=/(합\s*계|총\s*액|총\s*[가-힣]*\s*금\s*액|결\s*제\s*금\s*액|승\s*인\s*금\s*액|판\s*매\s*금\s*액|거\s*래\s*금\s*액|청\s*구\s*금\s*액|금\s*액)/;
  const excludeKw=/(받\s*은|거\s*스\s*름|현\s*금\s*받|면\s*세|부\s*가\s*세|공\s*급\s*가|포\s*인\s*트|할\s*인)/; // 합계가 아닌 보조 금액
  const MAX=100000000; // 1억 초과 숫자는 금액 후보에서 제외(번호 오인식)
  const toNum=s=>Number(String(s).replace(/[.,\s]/g,'')); // 콤마·점·공백 제거('16.900'→16900)

  // 숫자 직전 라벨(12자)로 받은/거스름/할인/포인트 옆 숫자를 제외하고, 합계 키워드면 가중치 부여
  const cand=[];
  const collectAmt=(reSrc,grp)=>{
    for(const l of lines){
      const re=new RegExp(reSrc,'g'); let m;
      while((m=re.exec(l))!==null){
        const n=toNum(grp?m[grp]:m[0]);
        if(!n||n>MAX)continue;
        const before=l.slice(Math.max(0,m.index-12),m.index);
        if(excludeKw.test(before))continue;
        cand.push({n, strong:strongKw.test(before)});
      }
    }
  };
  // 1차: 천단위 구분 숫자(16,900 / 16.900) — 결제번호·날짜·카드번호엔 3자리 그룹이 없어 자연히 제외됨
  collectAmt('\\d{1,3}(?:[.,]\\d{3})+', 0);
  // 2차: 그룹 숫자가 없을 때만 '원/뭔/윈/웜'이 붙은 숫자(공백 오인식 '16 900원'도 허용)
  if(!cand.length) collectAmt('(\\d[\\d.,\\s]*\\d|\\d)\\s*[원웜윈뭔]', 1);

  if(cand.length){
    const freq=new Map();
    cand.forEach(c=>freq.set(c.n,(freq.get(c.n)||0)+1));
    const strongVals=[...new Set(cand.filter(c=>c.strong).map(c=>c.n))];
    const pool=strongVals.length?strongVals:[...freq.keys()];
    pool.sort((a,b)=>(freq.get(b)-freq.get(a))||(b-a)); // 최빈값 우선, 동률이면 큰 값
    result.amount=pool[0];
  }else{
    // 폴백: 구분기호·'원' 모두 없을 때. 번호/카드/사업자/날짜 줄 제외, 6자리 이상은 ID로 제외
    const idKw=/(번\s*호|카\s*드|사\s*업\s*자|연\s*락\s*처|전\s*화|단\s*말|할\s*부|등\s*록|거\s*래\s*일|일\s*시|날\s*짜)/;
    let kwN=0,mxN=0;
    for(const l of lines){
      if(excludeKw.test(l))continue;
      if(idKw.test(l)&&!strongKw.test(l))continue;
      const isStrong=strongKw.test(l);
      (l.match(/\d+/g)||[]).forEach(s=>{if(s.length>=6)return;const n=Number(s);if(n&&n<=MAX){if(n>mxN)mxN=n;if(isStrong&&n>kwN)kwN=n;}});
    }
    result.amount=kwN||mxN;
  }

  // ---- 상호명(거래처): 라벨 뒤 값을 추출하되 복합 라벨('가맹점 주문번호' 등)은 건너뜀 ----
  const vendorKw=/(상\s*호\s*명|상\s*호|가\s*맹\s*점\s*명|가\s*맹\s*점|상\s*점\s*명|매\s*장\s*명|매\s*장|점\s*포\s*명|점\s*포|가\s*게\s*명|판\s*매\s*자)/;
  const labelStop=/(대\s*표|사\s*업\s*자|연\s*락\s*처|주\s*소|등\s*록\s*번\s*호|전\s*화|승\s*인|카\s*드|금\s*액|번\s*호|일\s*시|상\s*품\s*명)/;
  const leadStop=/^(주\s*문|번\s*호|유\s*형|코\s*드|구\s*분|시\s*간|일\s*시|상\s*태|명\s*세)/;
  // 섹션 헤더 단어: '가맹점 정보' → '정보'처럼 키워드만 남은 경우 사용처로 쓰면 안 됨
  const sectionHeaderOnly=/^(정보|안내|현황|내역|목록|상세|요약|조회|내용)$/;
  for(let i=0;i<lines.length;i++){
    const l=lines[i];
    if(!vendorKw.test(l))continue;
    let after=l.replace(vendorKw,'').replace(/^[\s:;|*]+/,'');
    if(leadStop.test(after))continue;
    const stop=after.match(labelStop);
    if(stop)after=after.slice(0,stop.index);
    let v=after.replace(/[:;|*]/g,' ').replace(/\s+/g,' ').trim();
    // 섹션 헤더 단어('정보' 등)만 남은 경우 → 다음 줄에서 실제 가맹점명 찾기
    if(sectionHeaderOnly.test(v)) v='';
    if(v.length<2 && i+1<lines.length){
      const nx=lines[i+1]; // 값이 다음 줄에 분리된 경우
      if(/[가-힣A-Za-z]/.test(nx)&&!labelStop.test(nx)&&!vendorKw.test(nx)&&!/\d{3}/.test(nx)&&!sectionHeaderOnly.test(nx.trim()))
        v=nx.replace(/[:;|*]/g,' ').replace(/\s+/g,' ').trim();
    }
    if(v.length>=2 && /[가-힣A-Za-z]/.test(v)){result.vendor=v;break;}
  }
  if(!result.vendor){
    const ex=/(거\s*래\s*확\s*인|확\s*인\s*[증중징]|영수증|전표|카드|승인|결제|금\s*액|합계|단말|주문|번호|사업자|대표|주소|연락|일시|포인트|할인|상품|운임|운수|pay|kakao|카카오|naver|네이버|toss|토스|페이|정보)/i;
    for(const l of lines){
      if(l.length>=2 && l.length<=30 && /[가-힣]/.test(l) && !/\d{3}/.test(l) && !ex.test(l)){
        result.vendor=l.replace(/[:;|*]/g,' ').replace(/\s+/g,' ').trim();
        break;
      }
    }
  }

  // ---- 계정과목 추정 및 적요(메모) 자동 생성 ----
  // 사용처 키워드에 따라 적요를 고정값으로 자동 입력한다.
  //   숙박류(호텔/모텔/숙박 등)        → "출장 숙박비"
  //   한국철도공사/코레일/KTX 등       → "기차비"
  //   카카오T/티머니/택시/운수 등      → "택시비"
  const fullText = text.replace(/\s+/g, '').toLowerCase();
  let categoryKeyword = '';   // 사용처와 합쳐 쓰는 적요 키워드 (예: "○○ 식대")
  let memoOverride = '';      // 사용처 키워드 기반 고정 적요
  if(/모텔|호텔|motel|hotel|숙박|여관|리조트|콘도|펜션|여행/.test(fullText)) {
    result.account = '(판)여비교통비-(국내출장비)';
    categoryKeyword = '숙박비';
    memoOverride = '출장 숙박비';
  } else if(/한국철도공사|코레일|korail|ktx|srt|철도|기차/.test(fullText)) {
    result.account = '(판)여비교통비-(시내교통비)';
    categoryKeyword = '기차비';
    memoOverride = '기차비';
  } else if(/택시|taxi|카카오티|카카오t|카카오모빌리티|티머니|tmoney|운수|진모빌리티|우티|uti|타다|tada/.test(fullText)) {
    result.account = '(판)여비교통비-(시내교통비)';
    categoryKeyword = '택시비';
    memoOverride = '택시비';
  } else if(/버스|지하철|교통|주유|충전/.test(fullText)) {
    result.account = '(판)여비교통비-(시내교통비)';
    categoryKeyword = '교통비';
  } else if(/식당|음식|구내식당|커피|카페|coffee|cafe|베이커리|레스토랑|한식|중식|일식|분식|치킨|피자|식비|외식/.test(fullText)) {
    result.account = '(판)복리후생비';
    categoryKeyword = '식대';
  }

  // 사용처(Vendor) 정제: 앞에 붙은 특수기호(예: €) 티마모델 -> 티마모델) 제거
  if (result.vendor) {
    result.vendor = result.vendor.replace(/^[^a-zA-Z가-힣0-9(]+/, '').trim();
    // 흔한 OCR 오인식 보정 (모델 -> 모텔)
    if (categoryKeyword === '숙박비' && result.vendor.includes('모델')) {
      result.vendor = result.vendor.replace('모델', '모텔');
    }
  }

  // 적요 자동 완성: 고정 적요(memoOverride)가 있으면 우선 적용,
  // 없으면 "사용처 + 키워드" 형식으로 생성 (예: 테마모텔 숙박비)
  if (memoOverride) {
    result.memo = memoOverride;
  } else if (result.vendor) {
    result.memo = categoryKeyword ? `${result.vendor} ${categoryKeyword}` : `${result.vendor} 결제`;
  }

  // ---- 택시 결제는 사용처를 '택시'로 통일 ----
  const taxiKw=/택시|카카오택시|카카오\s*t|카카오모빌리티|이동의\s*즐거움|티머니|tmoney|진모빌리티|우티|uti|타다|tada/i;
  if(taxiKw.test(text) || taxiKw.test(result.vendor)) {
    result.vendor = '택시';
    result.memo = '택시비';
  }

  return result;
}

// IndexedDB 래퍼
const DB_NAME='ExpenseDB';
function initDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,1);
    req.onupgradeneeded=e=>{
      const db=e.target.result;
      if(!db.objectStoreNames.contains('receipts')) db.createObjectStore('receipts',{keyPath:'id'});
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
// 영수증 이미지 세션 캐시: 같은 전표를 다시 열 때 재다운로드하지 않도록 메모리에 보관.
const _imageCache = new Map();
async function saveImage(id, dataUrl){
  _imageCache.set(String(id), dataUrl);
  if (isLoggedIn() && typeof id === 'number') {
    try {
      const res = await fetch(`/api/expenses/${id}/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getHeaders() },
        body: JSON.stringify({ dataUrl })
      });
      if (res.ok) return;
    } catch(e) {
      console.error('서버 이미지 업로드 실패:', e.message);
    }
  }

  const db=await initDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('receipts','readwrite');
    const queryKey = isNaN(id) ? id : Number(id);
    tx.objectStore('receipts').put({id: queryKey, dataUrl});
    tx.oncomplete=resolve;
    tx.onerror=reject;
  });
}
async function getImage(id){
  const cacheKey = String(id);
  if (_imageCache.has(cacheKey)) return _imageCache.get(cacheKey);

  const isNumericId = id !== null && id !== '' && !isNaN(id);
  if (isLoggedIn() && isNumericId) {
    try {
      const res = await fetch(`/api/expenses/${id}/image`, { headers: getHeaders() });
      if (res.ok) {
        const data = await res.json();
        if (data.dataUrl) { _imageCache.set(cacheKey, data.dataUrl); return data.dataUrl; }
      }
    } catch(e) {}
  }

  const db=await initDB();
  return new Promise((resolve,reject)=>{
    const queryKey = isNaN(id) ? id : Number(id);
    const req=db.transaction('receipts').objectStore('receipts').get(queryKey);
    req.onsuccess=()=>{ const url=req.result?req.result.dataUrl:null; if(url) _imageCache.set(cacheKey, url); resolve(url); };
    req.onerror=()=>resolve(null);
  });
}
async function deleteImage(id){
  _imageCache.delete(String(id));
  const db=await initDB();
  const tx=db.transaction('receipts','readwrite');
  const queryKey = isNaN(id) ? id : Number(id);
  tx.objectStore('receipts').delete(queryKey);
}
async function renameImage(oldId, newId) {
  const dataUrl = await getImage(oldId);
  if (dataUrl) {
    await saveImage(newId, dataUrl);
    await deleteImage(oldId);
  }
}

// 보관기간(RETENTION_DAYS) 경과한 오래된 영수증 자동 삭제 (IndexedDB 클린업)
async function cleanupOldImages() {
  try {
    const db = await initDB();
    const tx = db.transaction('receipts', 'readwrite');
    const store = tx.objectStore('receipts');
    
    let deletedCount = 0;
    const now = Date.now();
    
    // 1. 전표 데이터 기준 (해당 월 종료일 + RETENTION_DAYS 경과)
    if (typeof entries !== 'undefined' && Array.isArray(entries)) {
      entries.forEach(e => {
        if (!e.date) return;
        const [yyyy, mm] = e.date.split('-');
        const monthEnd = new Date(yyyy, mm, 0).getTime();
        if (now > monthEnd + RETENTION_MS) {
          store.delete(isNaN(e.id) ? e.id : Number(e.id));
          deletedCount++;
        }
      });
    }

    // 2. 과거 게스트 데이터 등 (타임스탬프 키 기준 RETENTION_DAYS 경과)
    const cutoff = now - RETENTION_MS;
    const req = store.openCursor();
    req.onsuccess = (ev) => {
      const cursor = ev.target.result;
      if (cursor) {
        if (typeof cursor.key === 'number' && cursor.key > 1000000000000 && cursor.key < cutoff) {
          cursor.delete();
          deletedCount++;
        }
        cursor.continue();
      } else if (deletedCount > 0) {
        console.log(`🧹 ${RETENTION_DAYS}일 경과 영수증 이미지 자동 삭제 완료`);
      }
    };
  } catch (e) {
    console.error('영수증 이미지 자동 정리에 실패했습니다:', e.message);
  }
}

// 명도 배열에 샤프닝(언샤프) 적용 — 업스케일로 흐려진 글자 경계를 또렷하게
function sharpenLum(lum, w, h) {
  const out = new Uint8ClampedArray(lum.length);
  // 중앙 5, 상하좌우 -1 (합 1) 표준 샤프닝 커널
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const up = y > 0 ? lum[i - w] : lum[i];
      const dn = y < h - 1 ? lum[i + w] : lum[i];
      const lf = x > 0 ? lum[i - 1] : lum[i];
      const rt = x < w - 1 ? lum[i + 1] : lum[i];
      out[i] = 5 * lum[i] - up - dn - lf - rt;
    }
  }
  return out;
}

function resizeImage(file, maxDim = 1600, binarize = false, allowUpscale = false) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        const maxSide = Math.max(w, h);
        // OCR용(allowUpscale): 해상도가 낮을수록 적극적으로 확대해 글자를 키움(최대 3.5배),
        //   너무 크면 축소. 저장용은 축소만.
        let scale;
        if (allowUpscale) {
          const MIN_OCR = 1800, MAX_OCR = 2400, MAX_UP = 3.5;
          if (maxSide < MIN_OCR) scale = Math.min(MAX_UP, MIN_OCR / maxSide);
          else if (maxSide > MAX_OCR) scale = MAX_OCR / maxSide;
          else scale = 1;
        } else {
          scale = Math.min(1, maxDim / maxSide);
        }
        const didUpscale = scale > 1.01;
        w = Math.round(w * scale);
        h = Math.round(h * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high'; // 확대 시 더 매끄러운 보간
        ctx.drawImage(img, 0, 0, w, h);
        if(binarize){
          const imageData = ctx.getImageData(0, 0, w, h);
          const data = imageData.data;
          // 1) 명도 계산
          let lum = new Uint8ClampedArray(data.length / 4);
          for (let i = 0, j = 0; i < data.length; i += 4, j++) {
            lum[j] = (0.2126 * data[i] + 0.7152 * data[i+1] + 0.0722 * data[i+2]) | 0;
          }
          // 1-1) 업스케일한 경우에만 샤프닝(흐린 저해상도 이미지 인식률 향상)
          if (didUpscale) lum = sharpenLum(lum, w, h);
          // 2) 히스토그램 + Otsu 자동 임계값(조명/배경에 적응)
          const hist = new Array(256).fill(0);
          for (let j = 0; j < lum.length; j++) hist[lum[j]]++;
          const total = lum.length;
          let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
          let sumB = 0, wB = 0, maxVar = -1, thr = 128;
          for (let t = 0; t < 256; t++) {
            wB += hist[t]; if (wB === 0) continue;
            const wF = total - wB; if (wF === 0) break;
            sumB += t * hist[t];
            const mB = sumB / wB, mF = (sum - sumB) / wF;
            const between = wB * wF * (mB - mF) * (mB - mF);
            if (between > maxVar) { maxVar = between; thr = t; }
          }
          // 3) 이진화
          for (let i = 0, j = 0; i < data.length; i += 4, j++) {
            const v = lum[j] > thr ? 255 : 0;
            data[i] = data[i+1] = data[i+2] = v;
          }
          ctx.putImageData(imageData, 0, 0);
        }
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 저장용 자동 압축: 데이터 URL 길이가 목표 이하가 될 때까지 품질 → 해상도 순으로 단계적으로 낮춘다.
// 서버 한도(MAX_IMAGE_CHARS=5,000,000)보다 여유 있게 잡아 업로드가 거부되지 않도록 한다.
function resizeImageForSave(file, maxChars = 4_500_000) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const render = (maxDim, q) => {
          const maxSide = Math.max(img.width, img.height);
          const scale = Math.min(1, maxDim / maxSide);
          const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, w, h);
          return canvas.toDataURL('image/jpeg', q);
        };
        const dims = [1200, 1000, 800, 640, 480];
        const qualities = [0.85, 0.7, 0.55, 0.4];
        let url = render(dims[0], qualities[0]);
        // 1) 품질을 먼저 낮춰 본다 (해상도 유지)
        for (let qi = 1; qi < qualities.length && url.length > maxChars; qi++) {
          url = render(dims[0], qualities[qi]);
        }
        // 2) 그래도 크면 해상도를 단계적으로 축소한다 (최저 품질 유지)
        for (let di = 1; di < dims.length && url.length > maxChars; di++) {
          url = render(dims[di], qualities[qualities.length - 1]);
        }
        resolve(url);
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const ocrProgress=document.getElementById('ocrProgress');
const ocrBar=document.getElementById('ocrBar');
// id가 자동으로 전역이 되는 브라우저 동작에 기대지 않고 명시적으로 잡는다.
// 그 동작에 기대면 id를 바꿨을 때 경고 없이 런타임에서만 깨진다.
const receiptBtn=document.getElementById('receiptBtn');
const receiptFile=document.getElementById('receiptFile');

// Tesseract 워커: 고정밀(best) 한국어 모델 사용. 한 번 만들어 재사용(모델은 브라우저에 캐시됨)
let ocrWorker=null, ocrWorkerLoading=null;
async function getOcrWorker(){
  if(ocrWorker)return ocrWorker;
  if(!ocrWorkerLoading){
    ocrWorkerLoading=loadScriptOnce(CDN.tesseract).then(()=>Tesseract.createWorker('kor+eng', 1, {
      // 4.0.0_best = 정확도 우선 LSTM 모델(기본 모델보다 큼, 첫 스캔만 느림)
      langPath:'https://tessdata.projectnaptha.com/4.0.0_best',
      logger:m=>{ if(m.status==='recognizing text') ocrBar.style.width=Math.round(m.progress*100)+'%'; }
    }).then(w=>{ ocrWorker=w; return w; }));
  }
  return ocrWorkerLoading;
}

receiptBtn.onclick=()=>{
  receiptFile.value='';
  receiptFile.click();
};
receiptFile.onchange=(e)=>{
  const files=e.target.files;
  if(files && files.length>0) fillFromReceipt(files);
};

let receiptBusy=false;

// 네이버 CLOVA OCR API를 서버 프록시(/api/ocr)로 호출
// 성공 시 인식 텍스트 반환, 실패/미설정 시 null 반환 (→ Tesseract.js 폴백)
async function tryNaverOCR(imageDataUrl) {
  try {
    const res = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: imageDataUrl })
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.fallback) {
      console.log('CLOVA OCR 폴백:', data.reason);
      return null;
    }
    return data.text || null;
  } catch (e) {
    console.warn('CLOVA OCR 요청 실패, Tesseract.js로 전환합니다.', e);
    return null;
  }
}

async function fillFromReceipt(files){
  if(receiptBusy || files.length===0) return;
  receiptBusy=true;
  receiptBtn.disabled=true;
  ocrProgress.style.display='block';

  try {
    await runReceiptScan(files);
  } catch(err) {
    // 잠금이 걸린 채로 조용히 끝나면 사용자는 이유를 알 수 없다.
    console.error('영수증 처리 오류:', err.message);
    await showAlert('영수증 처리 중 오류가 발생했습니다. 다시 시도해주세요.');
  } finally {
    // 반드시 finally에서 푼다. 여기서 놓치면 예외 한 번에 스캔 버튼이
    // 새로고침 전까지 잠겨 영수증을 아예 못 찍는다.
    receiptBusy=false;
    receiptBtn.disabled=false;
    receiptBtn.textContent='📷 여러 장의 영수증 일괄 스캔';
    setTimeout(()=>{ocrProgress.style.display='none';ocrBar.style.width='0%';},600);
  }
}

// fillFromReceipt의 본문. 잠금 해제를 호출부의 finally에 맡기기 위해 분리했다.
async function runReceiptScan(files){
  let successCount=0;
  for(let i=0; i<files.length; i++){
    const file = files[i];
    ocrBar.style.width='0%';
    try {
      const saveUrl = await resizeImageForSave(file);
      // Google Vision OCR용: 이진화 없이 원본 품질 이미지 사용 (API가 직접 처리)
      const imgUrlForClova = await resizeImage(file, 1600, false);
      // Tesseract 폴백용: 이진화 처리 이미지
      const imgUrlForTess = await resizeImage(file, 1800, true, true);

      let recognizedText = null;

      // 1단계: Google Vision OCR 시도
      receiptBtn.textContent=`영수증 분석 중… (${i+1}/${files.length} Google Vision OCR)`;
      ocrBar.style.width='20%';
      recognizedText = await tryNaverOCR(imgUrlForClova);
      ocrBar.style.width='70%';

      // 2단계: Google Vision 실패 시 Tesseract.js로 폴백
      if (recognizedText === null) {
        receiptBtn.textContent=`영수증 분석 중… (${i+1}/${files.length} 텍스트 인식)`;
        ocrBar.style.width='30%';
        const worker = await getOcrWorker();
        const {data} = await worker.recognize(imgUrlForTess);
        recognizedText = data.text;
      }

      ocrBar.style.width='100%';
      const r = parseReceipt(recognizedText);
      clearErrors();
      
      const tempId = Date.now() + i;
      
      if(files.length === 1){
        await saveImage(tempId, saveUrl);
        pendingReceiptImageId = tempId; // submit시 리네임
        
        if(!document.getElementById('overlay').classList.contains('open')){
          newEntry();
        }
        document.getElementById('fDate').value=r.date;
        document.getElementById('fDebit').value=Number(r.amount).toLocaleString('ko-KR');
        document.getElementById('fMemo').value=r.memo || '';
        document.getElementById('fVendor').value=r.vendor;
        if(r.account) {
          document.getElementById('fAccount').value=r.account;
        } else {
          suggestAccount();
        }
        
        const addHint=document.getElementById('addHint');
        addHint.style.color='var(--green)';
        addHint.textContent='자동인식 완료';
        setTimeout(()=>addHint.textContent='',3500);
      } else {
        const item = {
          date: r.date,
          account: r.account || '미지급금-(직원경비)',
          debit: r.amount || 0,
          credit: 0,
          memo: r.memo || '',
          vendor: r.vendor || '',
          department: '',
          employeeName: isLoggedIn() ? (localStorage.getItem('expense_user_name') || '') : '사원명 입력'
        };
        
        if (isLoggedIn()) {
          // 회원인 경우 즉시 DB 전송
          const res = await fetch('/api/expenses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getHeaders() },
            body: JSON.stringify(item)
          });
          if (res.ok) {
            const saved = await res.json();
            await saveImage(saved.id, saveUrl);
            entries.push(saved);
          }
        } else {
          // 게스트인 경우 로컬 전송
          await saveImage(tempId, saveUrl);
          entries.push({ id: tempId, ...item });
        }
      }
      successCount++;
    } catch(err) {
      console.error('OCR 오류:', err.message);
    }
  }
  
  if(files.length > 1){
    if (!isLoggedIn()) {
      localStorage.setItem(STORAGE_KEY,JSON.stringify(entries));
    }
    renderAll();
    await showAlert(`${successCount}장의 영수증이 등록되었습니다. 목록에서 적요를 마저 채워주세요.`);
  }
}

/* ---- receipt fullscreen zoom/pan ---- */
(function(){
  const overlay = document.getElementById('receiptZoomOverlay');
  const stage = document.getElementById('zoomStage');
  const img = document.getElementById('zoomImg');
  const MIN = 1, MAX = 5;
  let scale = 1, tx = 0, ty = 0;

  function clampScale(s){ return Math.max(MIN, Math.min(MAX, s)); }
  function clampPan(){
    // keep the image from drifting too far off-screen
    const maxX = Math.max(0, (img.offsetWidth * scale - window.innerWidth) / 2);
    const maxY = Math.max(0, (img.offsetHeight * scale - window.innerHeight) / 2);
    tx = Math.max(-maxX, Math.min(maxX, tx));
    ty = Math.max(-maxY, Math.min(maxY, ty));
  }
  function apply(){ clampPan(); img.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; }
  function reset(){ scale = 1; tx = 0; ty = 0; img.style.transform = ''; }
  function animate(on){ img.classList.toggle('animating', on); }

  function openZoom(src){
    img.src = src; reset(); overlay.classList.add('open');
  }
  function closeZoom(){
    overlay.classList.remove('open'); img.src = ''; reset();
  }
  // IIFE 밖(전표 목록의 영수증 클릭)에서도 호출하므로 전역으로 노출한다.
  window.openZoom = openZoom;
  window.closeZoom = closeZoom;

  document.getElementById('zoomClose').onclick = () => closeZoom();

  // zoom toward a screen point, keeping that point stable
  function zoomTo(newScale, cx, cy){
    newScale = clampScale(newScale);
    const ratio = newScale / scale;
    // point relative to image center (stage center == viewport center)
    const ox = cx - window.innerWidth / 2;
    const oy = cy - window.innerHeight / 2;
    tx = ox - (ox - tx) * ratio;
    ty = oy - (oy - ty) * ratio;
    scale = newScale;
    apply();
  }

  // ---- double tap / double click ----
  let lastTap = 0;
  function toggleZoom(cx, cy){
    animate(true);
    if (scale > 1.01) { reset(); }
    else { zoomTo(2.5, cx, cy); }
    setTimeout(() => animate(false), 240);
  }
  img.addEventListener('dblclick', e => { e.preventDefault(); toggleZoom(e.clientX, e.clientY); });

  // ---- mouse drag pan ----
  let dragging = false, lastX = 0, lastY = 0;
  img.addEventListener('mousedown', e => {
    if (scale <= 1.01) return;
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    img.classList.add('grabbing'); e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    tx += e.clientX - lastX; ty += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY; apply();
  });
  window.addEventListener('mouseup', () => { dragging = false; img.classList.remove('grabbing'); });

  // ---- wheel zoom (desktop) ----
  stage.addEventListener('wheel', e => {
    if (!overlay.classList.contains('open')) return;
    e.preventDefault();
    zoomTo(scale * (e.deltaY < 0 ? 1.12 : 0.89), e.clientX, e.clientY);
  }, { passive: false });

  // ---- touch: pinch zoom + 1-finger pan + double tap ----
  let pinchDist = 0, pinchScale = 1, pinchCX = 0, pinchCY = 0;
  let touchPan = false, tLastX = 0, tLastY = 0;
  function dist(t){ const dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.hypot(dx, dy); }

  stage.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      pinchDist = dist(e.touches); pinchScale = scale;
      pinchCX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      pinchCY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      touchPan = false;
    } else if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTap < 300) { e.preventDefault(); toggleZoom(e.touches[0].clientX, e.touches[0].clientY); lastTap = 0; }
      else { lastTap = now; }
      if (scale > 1.01) { touchPan = true; tLastX = e.touches[0].clientX; tLastY = e.touches[0].clientY; }
    }
  }, { passive: false });

  stage.addEventListener('touchmove', e => {
    if (e.touches.length === 2 && pinchDist) {
      e.preventDefault();
      const ratio = dist(e.touches) / pinchDist;
      zoomTo(pinchScale * ratio, pinchCX, pinchCY);
    } else if (e.touches.length === 1 && touchPan) {
      e.preventDefault();
      tx += e.touches[0].clientX - tLastX; ty += e.touches[0].clientY - tLastY;
      tLastX = e.touches[0].clientX; tLastY = e.touches[0].clientY; apply();
    }
  }, { passive: false });

  stage.addEventListener('touchend', e => {
    if (e.touches.length < 2) pinchDist = 0;
    if (e.touches.length === 0) touchPan = false;
  });

  // ---- backdrop tap closes when not zoomed ----
  stage.addEventListener('click', e => {
    if (e.target !== img && scale <= 1.01) closeZoom();
  });
})();

document.addEventListener('keydown',e=>{
  if(e.key!=='Escape')return;
  if(document.getElementById('receiptZoomOverlay').classList.contains('open')){window.closeZoom();return;}
  if(document.getElementById('confirmOverlay').classList.contains('open')){closeConfirm();return;}
  if(document.getElementById('overlay').classList.contains('open')){closeModal();return;}
  if(document.getElementById('dayOverlay').classList.contains('open')){closeDayModal();return;}
  if(document.getElementById('authOverlay').classList.contains('open')){closeAuthModal();return;}
});

/* ---- nav ---- */
const goPrevMonth=()=>{viewDate.setMonth(viewDate.getMonth()-1);renderAll();};
const goNextMonth=()=>{viewDate.setMonth(viewDate.getMonth()+1);renderAll();};
document.getElementById('prevBtn').onclick=goPrevMonth;
document.getElementById('nextBtn').onclick=goNextMonth;
document.getElementById('listPrevBtn').onclick=goPrevMonth;
document.getElementById('listNextBtn').onclick=goNextMonth;
document.getElementById('todayBtn').onclick=()=>{viewDate=new Date();renderAll();};

/* ---- View Tabs Toggle ---- */
let isCalOpen = false;
document.getElementById('btnToggleCal').onclick = () => {
  isCalOpen = !isCalOpen;
  const calContainer = document.getElementById('calContainer');
  const btnToggleCal = document.getElementById('btnToggleCal');
  if (isCalOpen) {
    calContainer.style.display = 'block';
    btnToggleCal.textContent = '📅 달력 접기 ▲';
    btnToggleCal.className = 'btn btn-primary';
    btnToggleCal.style.border = 'none';
    btnToggleCal.style.background = ''; // Clear inline background so css works
    btnToggleCal.style.color = '#fff';
    renderCalendar();
  } else {
    calContainer.style.display = 'none';
    btnToggleCal.textContent = '📅 달력 펼치기 ▼';
    btnToggleCal.className = 'btn btn-ghost';
    btnToggleCal.style.border = 'none';
    btnToggleCal.style.background = 'transparent';
    btnToggleCal.style.color = 'var(--ink-2)';
  }
};

/* ---- export: 엑셀 + 영수증 이미지를 ZIP 하나로 즉시 다운로드 ---- */
function buildMonthSheet(wb, ms, rows){
  const sorted = rows.slice().sort((a,b)=>a.date.localeCompare(b.date)||a.id-b.id);
  // 회계일은 지출한 달의 말일이다. ERP 분개전표 화면처럼 표 위 머리 칸에 둔다.
  const [y, m] = ms.split('-').map(Number);
  const acctDate = `${ms}-${pad(new Date(y, m, 0).getDate())}`;
  const aoa=[['회계일', acctDate], [], ['행번호','계정과목','비용구분','차변금액','대변금액','적요','귀속부서','활동센터']];
  sorted.forEach((e, i)=>{
    const dArr = e.date.split('-');
    const memoStr = `${dArr[0].slice(2)}.${dArr[1]}.${dArr[2]} ${e.memo||''}`.trim();
    aoa.push([String(i+1).padStart(4, '0'), e.account, '판매', e.debit, e.credit, memoStr, e.department||'', e.department||'']);
  });
  const td=sorted.reduce((s,e)=>s+Number(e.debit||0),0);
  // 미지급금(대변)도 ERP 업로드 양식에 맞춰 전표 행에 이어지는 행번호를 부여한다.
  aoa.push([String(sorted.length+1).padStart(4, '0'),'미지급금-(직원경비)','','',td,payableMemo(m,sorted),'','']);
  const ws=XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols']=[{wch:10},{wch:26},{wch:10},{wch:12},{wch:12},{wch:34},{wch:16},{wch:16}];
  XLSX.utils.book_append_sheet(wb, ws, ms);
}

const exportBtn = document.getElementById('exportBtn');
exportBtn.onclick = async () => {
  const rows = filtered();
  if(rows.length === 0){ await showAlert('해당 월에 내보낼 전표가 없습니다.'); return; }

  const origHtml = exportBtn.innerHTML;
  exportBtn.disabled = true;
  exportBtn.textContent = '⏳ 엑셀 생성 중...';

  try {
    await Promise.all([loadScriptOnce(CDN.xlsx), loadScriptOnce(CDN.jszip), loadScriptOnce(CDN.filesaver)]);
    const ms = monthStr();
    const zip = new JSZip();

    // 1) 전표 엑셀
    const wb = XLSX.utils.book_new();
    buildMonthSheet(wb, ms, rows);
    zip.file(`전표_${ms}.xlsx`, XLSX.write(wb, {bookType:'xlsx', type:'array'}));

    // 2) 영수증 원본 이미지
    let imgCount = 0;
    const nameCount = {};  // 같은 날·같은 사용처 중복 시 번호 부여용
    // 로그인 시 파일명에 사용자 이름 포함 (날짜_이름_사용처)
    const userName = isLoggedIn() ? (localStorage.getItem('expense_user_name') || '').trim() : '';
    const safeName = userName.replace(/[\/\\:*?"<>|]/g, '_');

    for(let i = 0; i < rows.length; i++){
      exportBtn.textContent = `⏳ 영수증 ${i+1}/${rows.length}`;
      const e = rows[i];
      const dataUrl = await getImage(e.id);
      if(!dataUrl) continue;
      const base64Data = dataUrl.split(',')[1];
      const mime = /^data:image\/([a-z0-9.+-]+);/i.exec(dataUrl);
      let ext = (mime ? mime[1] : 'jpg').toLowerCase();
      if(ext === 'jpeg') ext = 'jpg';
      const vendorLabel = e.vendor || ACCOUNT_LABEL[e.account] || '알수없음';
      const safeVendor = vendorLabel.replace(/[\/\\:*?"<>|]/g, '_');
      const yymmdd = (e.date || '').slice(2).replace(/-/g, '');
      const base = safeName ? `${yymmdd}_${safeName}_${safeVendor}` : `${yymmdd}_${safeVendor}`;
      const n = (nameCount[base] = (nameCount[base] || 0) + 1);
      zip.file(`영수증/${base}${n > 1 ? n : ''}.${ext}`, base64Data, {base64: true});
      imgCount++;
    }

    exportBtn.textContent = '⏳ 압축 중...';
    const content = await zip.generateAsync({type:'blob'});
    saveAs(content, `전표_${ms}.zip`);

    if(imgCount === 0) await showAlert('저장된 영수증 이미지가 없어 엑셀만 압축했습니다.');
  } catch(err){
    console.error(err.message);
    await showAlert('내보내기 중 오류가 발생했습니다.');
  } finally {
    exportBtn.disabled = false;
    exportBtn.innerHTML = origHtml;
  }
};

/* --- 회원 가입 / 로그인 관련 인터랙션 제어 --- */
let authMode = 'login';

function openAuthModal() {
  resetAuthForm();
  document.getElementById('authOverlay').classList.add('open');
}
function closeAuthModal() {
  document.getElementById('authOverlay').classList.remove('open');
}
function resetAuthForm() {
  authMode = 'login';
  document.getElementById('tabLoginBtn').classList.add('active');
  document.getElementById('tabRegisterBtn').classList.remove('active');
  document.getElementById('authConfirmContainer').style.display = 'none';
  document.getElementById('authNameContainer').style.display = 'none';
  document.getElementById('authSubmitBtn').textContent = '로그인';
  document.getElementById('authEmail').value = '';
  document.getElementById('authPassword').value = '';
  document.getElementById('authPasswordConfirm').value = '';
  document.getElementById('authMessage').style.display = 'none';
  document.getElementById('forgotPwRow').style.display = 'block';
  clearAuthErrors();
  showAuthView('auth');
}
function clearAuthErrors() {
  document.getElementById('authEmailErr').closest('.field').classList.remove('invalid');
  document.getElementById('authPasswordErr').closest('.field').classList.remove('invalid');
  document.getElementById('authPasswordConfirmErr').closest('.field').classList.remove('invalid');
  
  const nameErr = document.getElementById('authNameErr');
  if (nameErr) nameErr.closest('.field').classList.remove('invalid');
  
}

// 로그인/회원가입 화면(auth)과 비밀번호 재설정 화면(reset) 전환
function showAuthView(view) {
  const isReset = view === 'reset';
  document.querySelector('#authOverlay .tab-header').style.visibility = isReset ? 'hidden' : 'visible';
  document.getElementById('authForm').style.display = isReset ? 'none' : 'block';
  document.getElementById('resetForm').style.display = isReset ? 'block' : 'none';
}

// 탭 선택 변경
document.getElementById('tabLoginBtn').onclick = () => {
  authMode = 'login';
  document.getElementById('tabLoginBtn').classList.add('active');
  document.getElementById('tabRegisterBtn').classList.remove('active');
  document.getElementById('authConfirmContainer').style.display = 'none';
  document.getElementById('authNameContainer').style.display = 'none';
  document.getElementById('authSubmitBtn').textContent = '로그인';
  document.getElementById('forgotPwRow').style.display = 'block';
  clearAuthErrors();
};
document.getElementById('tabRegisterBtn').onclick = () => {
  authMode = 'register';
  document.getElementById('tabRegisterBtn').classList.add('active');
  document.getElementById('tabLoginBtn').classList.remove('active');
  document.getElementById('authConfirmContainer').style.display = 'block';
  document.getElementById('authNameContainer').style.display = 'block';
  document.getElementById('authSubmitBtn').textContent = '회원가입';
  document.getElementById('forgotPwRow').style.display = 'none';
  clearAuthErrors();
};

document.getElementById('closeAuthModal').onclick = closeAuthModal;
document.getElementById('authOverlay').onclick = (e) => {
  if (e.target.id === 'authOverlay') closeAuthModal();
};

// 로그인/회원가입 요청 전송
document.getElementById('authForm').onsubmit = async (e) => {
  e.preventDefault();
  clearAuthErrors();
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const confirmPassword = document.getElementById('authPasswordConfirm').value;
  const name = document.getElementById('authName').value.trim();
  
  let hasErr = false;
  if (!email || !email.includes('@')) {
    document.getElementById('authEmailErr').closest('.field').classList.add('invalid');
    hasErr = true;
  }
  const pwdRegex = /^(?=.*[a-zA-Z])(?=.*\d)(?=.*[\W_]).{8,}$/;
  if (authMode === 'register' && !pwdRegex.test(password)) {
    document.getElementById('authPasswordErr').closest('.field').classList.add('invalid');
    hasErr = true;
  } else if (authMode === 'login' && password.length === 0) {
    document.getElementById('authPasswordErr').closest('.field').classList.add('invalid');
    hasErr = true;
  }
  if (authMode === 'register' && password !== confirmPassword) {
    document.getElementById('authPasswordConfirmErr').closest('.field').classList.add('invalid');
    hasErr = true;
  }
  // Name is now optional
  if (hasErr) return;
  
  const msgEl = document.getElementById('authMessage');
  msgEl.className = 'auth-message';
  msgEl.style.display = 'block';
  msgEl.textContent = '';
  
  const submitBtn = document.getElementById('authSubmitBtn');
  const originalText = authMode === 'login' ? '로그인' : '회원가입';
  setLoading(submitBtn, true, originalText);
  
  try {
    if (authMode === 'register') {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name })
      });
      const data = await res.json();
      if (res.ok) {
        msgEl.classList.add('success');
        msgEl.textContent = '회원가입이 완료되었습니다! 로그인해 주세요.';
        setTimeout(() => {
          document.getElementById('tabLoginBtn').click();
          document.getElementById('authPassword').value = '';
        }, 1200);
      } else {
        msgEl.classList.add('error');
        msgEl.textContent = data.error || '회원가입에 실패했습니다.';
      }
    } else {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (res.ok) {
        msgEl.classList.add('success');
        msgEl.textContent = '로그인 성공!';
        
        localStorage.setItem('expense_user_token', data.token);
        localStorage.setItem('expense_user_email', data.email);
        localStorage.setItem('expense_user_name', data.name || '');

        const localDataStr = localStorage.getItem(STORAGE_KEY);
        const localData = localDataStr ? JSON.parse(localDataStr) : [];

        if (localData.length > 0) {
          // 게스트 데이터가 있으면 동기화 안내 (짧은 지연으로 성공 메시지만 잠깐 노출)
          setTimeout(() => {
            closeAuthModal();
            document.getElementById('syncCountText').textContent = `${localData.length}건`;
            document.getElementById('syncOverlay').classList.add('open');
          }, 250);
        } else {
          // 전체 페이지 새로고침 대신 화면만 즉시 갱신해 로그인 후 대기 시간을 줄인다.
          closeAuthModal();
          updateAuthUI();
          await loadEntries();
          renderAll();
          cleanupOldImages().catch(e=>console.error(e));
        }
      } else {
        msgEl.classList.add('error');
        msgEl.textContent = data.error || '로그인에 실패했습니다.';
      }
    }
  } catch (err) {
    console.error(err.message);
    msgEl.classList.add('error');
    msgEl.textContent = '서버 통신 오류: ' + (err.message || '알 수 없는 오류');
  } finally {
    setLoading(submitBtn, false, originalText);
  }
};

/* --- 비밀번호 재설정 (이메일 인증 코드) --- */
let resetStage = 'request'; // 'request' = 코드 요청, 'verify' = 코드 검증/변경

function clearResetErrors() {
  ['resetEmailErr','resetCodeErr','resetPasswordErr','resetPasswordConfirmErr'].forEach(id => {
    document.getElementById(id).closest('.field').classList.remove('invalid');
  });
}
function resetResetForm() {
  resetStage = 'request';
  document.getElementById('resetEmail').value = '';
  document.getElementById('resetEmail').disabled = false;
  document.getElementById('resetCode').value = '';
  document.getElementById('resetPassword').value = '';
  document.getElementById('resetPasswordConfirm').value = '';
  document.getElementById('resetCodeStep').style.display = 'none';
  document.getElementById('resetPwStep').style.display = 'none';
  document.getElementById('resetPwConfirmStep').style.display = 'none';
  document.getElementById('resetMessage').style.display = 'none';
  document.getElementById('resetSubmitBtn').textContent = '인증 코드 받기';
  clearResetErrors();
}

document.getElementById('forgotPwLink').onclick = () => {
  resetResetForm();
  // 로그인 화면에 입력한 이메일이 있으면 이어받기
  const email = document.getElementById('authEmail').value.trim();
  if (email) document.getElementById('resetEmail').value = email;
  showAuthView('reset');
};
document.getElementById('backToLoginLink').onclick = () => {
  showAuthView('auth');
};

document.getElementById('resetForm').onsubmit = async (e) => {
  e.preventDefault();
  clearResetErrors();
  const email = document.getElementById('resetEmail').value.trim();
  const msgEl = document.getElementById('resetMessage');
  msgEl.className = 'auth-message';
  msgEl.style.display = 'none';
  msgEl.textContent = '';

  const submitBtn = document.getElementById('resetSubmitBtn');
  const pwdRegex = /^(?=.*[a-zA-Z])(?=.*\d)(?=.*[\W_]).{8,}$/;

  if (resetStage === 'request') {
    if (!email || !email.includes('@')) {
      document.getElementById('resetEmailErr').closest('.field').classList.add('invalid');
      return;
    }
    setLoading(submitBtn, true, '인증 코드 받기');
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await res.json();
      if (res.ok) {
        resetStage = 'verify';
        document.getElementById('resetEmail').disabled = true;
        document.getElementById('resetCodeStep').style.display = 'block';
        document.getElementById('resetPwStep').style.display = 'block';
        document.getElementById('resetPwConfirmStep').style.display = 'block';
        msgEl.className = 'auth-message success';
        msgEl.style.display = 'block';
        msgEl.textContent = data.message || '인증 코드를 보냈습니다. 메일함을 확인해주세요.';
      } else {
        msgEl.className = 'auth-message error';
        msgEl.style.display = 'block';
        msgEl.textContent = data.error || '인증 코드 발송에 실패했습니다.';
      }
    } catch (err) {
      console.error(err.message);
      msgEl.className = 'auth-message error';
      msgEl.style.display = 'block';
      msgEl.textContent = '서버 통신 오류: ' + (err.message || '알 수 없는 오류');
    } finally {
      // 코드 발송 성공 시 stage가 'verify'로 바뀌므로 버튼 라벨도 그에 맞춰 복원
      setLoading(submitBtn, false, resetStage === 'verify' ? '비밀번호 변경' : '인증 코드 받기');
    }
    return;
  }

  // resetStage === 'verify'
  const code = document.getElementById('resetCode').value.trim();
  const password = document.getElementById('resetPassword').value;
  const confirmPassword = document.getElementById('resetPasswordConfirm').value;
  let hasErr = false;
  if (!code) {
    document.getElementById('resetCodeErr').closest('.field').classList.add('invalid');
    hasErr = true;
  }
  if (!pwdRegex.test(password)) {
    document.getElementById('resetPasswordErr').closest('.field').classList.add('invalid');
    hasErr = true;
  }
  if (password !== confirmPassword) {
    document.getElementById('resetPasswordConfirmErr').closest('.field').classList.add('invalid');
    hasErr = true;
  }
  if (hasErr) return;

  setLoading(submitBtn, true, '비밀번호 변경');
  try {
    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, password })
    });
    const data = await res.json();
    if (res.ok) {
      msgEl.className = 'auth-message success';
      msgEl.style.display = 'block';
      msgEl.textContent = data.message || '비밀번호가 변경되었습니다. 로그인해주세요.';
      setTimeout(() => {
        resetResetForm();
        document.getElementById('authEmail').value = email;
        document.getElementById('authPassword').value = '';
        showAuthView('auth');
      }, 1500);
    } else {
      msgEl.className = 'auth-message error';
      msgEl.style.display = 'block';
      msgEl.textContent = data.error || '비밀번호 재설정에 실패했습니다.';
    }
  } catch (err) {
    console.error(err.message);
    msgEl.className = 'auth-message error';
    msgEl.style.display = 'block';
    msgEl.textContent = '서버 통신 오류: ' + (err.message || '알 수 없는 오류');
  } finally {
    setLoading(submitBtn, false, '비밀번호 변경');
  }
};

// 동기화 동의/거절 로직
document.getElementById('syncConfirmBtn').onclick = async () => {
  const localDataStr = localStorage.getItem(STORAGE_KEY);
  const localData = localDataStr ? JSON.parse(localDataStr) : [];
  
  if (localData.length > 0) {
    const syncBtn = document.getElementById('syncConfirmBtn');
    setLoading(syncBtn, true, '계정으로 동기화');
    try {
      // 로컬 데이터에 영수증 이미지가 있다면 서버 동기화 페이로드에 포함
      for (let i = 0; i < localData.length; i++) {
        const dataUrl = await getImage(localData[i].id);
        if (dataUrl) {
          localData[i].dataUrl = dataUrl;
        }
      }
      
      const res = await fetch('/api/expenses/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getHeaders() },
        body: JSON.stringify({ expenses: localData })
      });
      if (res.ok) {
        localStorage.removeItem(STORAGE_KEY);
        await discardGuestTrash();
        await showAlert('로컬 데이터 동기화 완료!');
      } else {
        const data = await res.json();
        await showAlert(`동기화 실패: ${data.error || '알 수 없는 오류'}`);
      }
    } catch (err) {
      console.error(err);
      await showAlert('동기화 처리 오류가 발생했습니다.');
    } finally {
      setLoading(syncBtn, false, '계정으로 동기화');
    }
  }
  document.getElementById('syncOverlay').classList.remove('open');
  location.reload();
};

document.getElementById('syncCancelBtn').onclick = async () => {
  if (await showConfirm('동기화하지 않으면 기존 로컬 데이터는 영구히 삭제됩니다. 정말 삭제하시겠습니까?', { okText: '삭제', danger: true })) {
    localStorage.removeItem(STORAGE_KEY);
    discardGuestTrash().finally(() => {
      document.getElementById('syncOverlay').classList.remove('open');
      location.reload();
    });
  }
};

// 공용 확인 모달: 브라우저 기본 confirm()이 화면 상단에 뜨는 문제를 없애고 앱 디자인과 일치시킨다.
function showConfirm(message, { okText = '확인', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('appConfirmOverlay');
    const msgEl = document.getElementById('appConfirmMessage');
    const okBtn = document.getElementById('appConfirmOkBtn');
    const cancelBtn = document.getElementById('appConfirmCancelBtn');
    msgEl.textContent = message;
    okBtn.textContent = okText;
    okBtn.style.background = danger ? 'var(--credit)' : '';
    okBtn.style.borderColor = danger ? 'var(--credit)' : '';
    cancelBtn.style.display = '';   // showAlert가 숨겨둔 상태일 수 있다
    const close = (result) => {
      overlay.classList.remove('open');
      okBtn.onclick = cancelBtn.onclick = overlay.onclick = null;
      resolve(result);
    };
    okBtn.onclick = () => close(true);
    cancelBtn.onclick = () => close(false);
    overlay.onclick = (e) => { if (e.target === overlay) close(false); };
    overlay.classList.add('open');
  });
}

// 공용 알림 모달. showConfirm과 같은 표면을 써서 네이티브 alert()의 이질감을 없앤다.
function showAlert(message, { okText = '확인' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('appConfirmOverlay');
    const msgEl = document.getElementById('appConfirmMessage');
    const okBtn = document.getElementById('appConfirmOkBtn');
    const cancelBtn = document.getElementById('appConfirmCancelBtn');
    msgEl.textContent = message;
    okBtn.textContent = okText;
    okBtn.style.background = '';
    okBtn.style.borderColor = '';
    cancelBtn.style.display = 'none';
    const close = () => {
      overlay.classList.remove('open');
      cancelBtn.style.display = '';
      okBtn.onclick = overlay.onclick = null;
      resolve();
    };
    okBtn.onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    overlay.classList.add('open');
  });
}

function updateAuthUI() {
  const container = document.getElementById('authStatusContainer');
  
  if (isLoggedIn()) {
    const email = localStorage.getItem('expense_user_email') || '사용자';
    container.innerHTML = `
      <div class="auth-badge user" id="accountBtn" style="cursor:pointer;" title="계정 관리">
        ✅ 로그인됨
      </div>
    `;
    
    document.getElementById('accountBtn').onclick = () => {
      document.getElementById('accountEmailText').textContent = email;
      document.getElementById('profileName').value = localStorage.getItem('expense_user_name') || '';
      
      document.getElementById('accountOverlay').classList.add('open');
    };
    
    document.getElementById('profileUpdateBtn').onclick = async () => {
      const name = document.getElementById('profileName').value.trim();
      const btn = document.getElementById('profileUpdateBtn');
      setLoading(btn, true, '정보 수정');
      try {
        const res = await fetch('/api/auth/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...getHeaders() },
          body: JSON.stringify({ name })
        });
        const data = await res.json();
        if(res.ok) {
          localStorage.setItem('expense_user_token', data.token);
          localStorage.setItem('expense_user_name', data.name);
          await showAlert('프로필이 업데이트되었습니다.');
        } else {
          await showAlert(data.error || '업데이트 실패');
        }
      } catch(e) {
        await showAlert('서버 오류');
      } finally {
        setLoading(btn, false, '정보 수정');
      }
    };

    document.getElementById('modalLogoutBtn').onclick = async () => {
      if (await showConfirm('로그아웃 하시겠습니까?')) {
        clearAuthStorage();
        location.reload();
      }
    };

    document.getElementById('modalDeleteAccountBtn').onclick = async () => {
      if (await showConfirm('정말로 회원 탈퇴를 하시겠습니까? 모든 전표 데이터와 영수증 이미지가 즉시 영구 삭제되며 복구할 수 없습니다.', { okText: '탈퇴', danger: true })) {
        try {
          const res = await fetch('/api/auth/me', {
            method: 'DELETE',
            headers: getHeaders()
          });
          if (res.ok) {
            await showAlert('회원 탈퇴가 완료되었습니다.');
            clearAuthStorage();
            location.reload();
          } else {
            const data = await res.json();
            await showAlert(`탈퇴 실패: ${data.error || '알 수 없는 오류'}`);
          }
        } catch(e) {
          console.error(e);
          await showAlert('탈퇴 처리 중 오류가 발생했습니다.');
        }
      }
    };
  } else {
    container.innerHTML = `
      <div class="auth-badge guest" id="navLoginBtn">
        ⚠️ 게스트
      </div>
    `;
    
    document.getElementById('navLoginBtn').onclick = () => openAuthModal();
  }
}

/* ---- init ---- */
function renderAll(){renderCalendar();renderList();}

async function init() {
  updateAuthUI();
  await loadEntries();
  if (sessionExpired) {
    updateAuthUI();          // 게스트 배지로 갱신
    renderAll();
    await showAlert('세션이 만료되었습니다. 다시 로그인해주세요.');
    openAuthModal();
    return;
  }
  renderAll();
  cleanupOldImages().catch(e=>console.error(e));
  purgeGuestTrash().catch(e=>console.error(e));
}

document.getElementById('fDate').value=ymd(new Date());
// 안내 문구의 보관 기간은 상수에서 생성해 값 변경 시 문구 누락을 막는다.
document.getElementById('retentionDaysText').textContent = RETENTION_DAYS;
document.getElementById('trashDaysText').textContent = TRASH_DAYS;
init();

// 오프라인 지원: 앱 셸을 캐싱해 신호가 약한 곳에서도 앱이 열리게 한다.
// 지원하지 않는 브라우저에서는 등록만 건너뛰고 기존과 동일하게 동작한다.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .catch(e => console.error('서비스워커 등록 실패:', e.message));
  });
}
