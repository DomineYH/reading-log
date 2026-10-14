/** Reading journal. Helpers/admin functions end in _ and cannot be called with google.script.run. */
const HEADERS_ = {
  Students: ['studentId','loginName','salt','verifier','active','version'],
  Records: ['recordId','studentId','requestId','startDate','finishDate','title','publisher','pages','impressions','createdAt','deleted','updatedAt','lastRequestId'],
  Sessions: ['tokenHash','studentId','version','expiresAt']
};
const ITERATIONS_ = 600000;
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index').setTitle('책갈피 · 나의 독서 기록')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
function props_() { return PropertiesService.getScriptProperties(); }
function db_() {
  const id = props_().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('SETUP_REQUIRED: 선생님이 연결을 확인해야 해요.');
  return SpreadsheetApp.openById(id);
}
function sheet_(name) {
  const s = db_().getSheetByName(name);
  if (!s) throw new Error('SETUP_REQUIRED: 선생님에게 알려 주세요.');
  return s;
}
function rows_(name) { return sheet_(name).getDataRange().getValues().slice(1); }
function lock_(fn) {
  const l = LockService.getScriptLock();
  if (!l.tryLock(15000)) throw new Error('BUSY: 잠시 뒤 다시 시도해 주세요.');
  try { return fn(); } finally { l.releaseLock(); }
}
function hex_(bytes) { return bytes.map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join(''); }
function hash_(s) { return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)); }
function hmac_(s) {
  const pepper = props_().getProperty('AUTH_PEPPER');
  if (!pepper) throw new Error('SETUP_REQUIRED');
  return hex_(Utilities.computeHmacSha256Signature(s, pepper, Utilities.Charset.UTF_8));
}
function equal_(a,b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let d = a.length ^ b.length;
  for (let i=0; i<Math.max(a.length,b.length); i++) d |= (a.charCodeAt(i)||0) ^ (b.charCodeAt(i)||0);
  return d === 0;
}
function name_(value) {
  if (typeof value !== 'string') throw new Error('VALIDATION_ERROR: 이름을 확인해 주세요.');
  const v = value.normalize('NFKC').trim();
  if (!v || v.length > 40 || /[\x00-\x1f\x7f]/.test(v)) throw new Error('VALIDATION_ERROR: 이름을 확인해 주세요.');
  return v;
}
function student_(name) { return rows_('Students').find(r => r[1] === name); }
// Persistent fixed buckets, not cache-only. Unknown names never create individual properties.
function limit_(key, maximum, seconds) {
  const p=props_(), now=Date.now(), old=JSON.parse(p.getProperty(key)||'null');
  const b=old && old.until>now ? old : {count:0,until:now+seconds*1000};
  if(b.count>=maximum) throw new Error('RATE_LIMIT: 시도가 많아요. 잠시 후 다시 해 주세요.');
  b.count++; p.setProperty(key,JSON.stringify(b));
}
function getLoginChallenge(name) {
  return lock_(() => {
    limit_('RATE_CHALLENGE',120,60);
    const n=name_(name), s=student_(n);
    return {salt:s ? s[2] : hmac_('fake-salt:'+n).slice(0,32),iterations:ITERATIONS_};
  });
}
function login(name, proof) {
  return lock_(() => {
    limit_('RATE_LOGIN_GLOBAL',120,600);
    const n=name_(name), s=student_(n);
    if(s) limit_('RATE_LOGIN_'+s[0],8,600);
    const valid=typeof proof==='string' && /^[a-f0-9]{64}$/.test(proof);
    const actual=hmac_('proof:'+ (s?s[2]:'unknown') + ':' + (valid?proof:''));
    if(!s || s[4]!==true || !valid || !equal_(s[3],actual)) throw new Error('LOGIN_FAILED: 이름 또는 비밀번호를 확인해 주세요.');
    pruneSessions_();
    const token=Utilities.getUuid()+Utilities.getUuid();
    sheet_('Sessions').appendRow([hash_(token),s[0],s[5],Date.now()+2*60*60*1000]);
    return {token:token,name:s[1]};
  });
}
function auth_(token) {
  if(typeof token!=='string'||token.length!==72) throw new Error('AUTH_REQUIRED: 다시 로그인해 주세요.');
  const t=hash_(token), session=rows_('Sessions').find(r=>equal_(r[0],t));
  if(!session||Number(session[3])<=Date.now()) throw new Error('AUTH_REQUIRED: 다시 로그인해 주세요.');
  const s=rows_('Students').find(r=>r[0]===session[1]);
  if(!s||s[4]!==true||Number(s[5])!==Number(session[2])) throw new Error('AUTH_REQUIRED: 다시 로그인해 주세요.');
  return s;
}
function getJournal(token) { return lock_(()=>journal_(auth_(token)[0])); }
function journal_(studentId) {
  const records=rows_('Records').filter(r=>r[1]===studentId&&r[10]!==true).map(r=>({
    id:r[0],startDate:String(r[3]),finishDate:String(r[4]),title:String(r[5]),publisher:String(r[6]),
    pages:Number(r[7]),impressions:String(r[8]),createdAt:String(r[9]),updatedAt:String(r[11]||r[9])
  })).reverse();
  return {records:records,totalPages:records.reduce((n,r)=>n+r.pages,0),completedCount:records.filter(r=>r.finishDate).length};
}
function text_(v,max,required) {
  if(typeof v!=='string') throw new Error('VALIDATION_ERROR: 입력 내용을 확인해 주세요.');
  const s=v.trim();
  if((required&&!s)||s.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) throw new Error('VALIDATION_ERROR: 글자 수나 입력 내용을 확인해 주세요.');
  return s;
}
function date_(v,required) {
  if(v===''&&!required) return '';
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('VALIDATION_ERROR: 날짜를 확인해 주세요.');
  const d=new Date(v+'T00:00:00Z');
  if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==v||v<'2000-01-01'||v>Utilities.formatDate(new Date(),'Asia/Seoul','yyyy-MM-dd')) throw new Error('VALIDATION_ERROR: 오늘까지의 올바른 날짜를 입력해 주세요.');
  return v;
}
function record_(p) {
  if(!p||typeof p!=='object') throw new Error('VALIDATION_ERROR');
  const start=date_(p.startDate,true),finish=date_(p.finishDate,false);
  if(finish&&finish<start) throw new Error('VALIDATION_ERROR: 다 읽은 날은 읽기 시작한 날 이후여야 해요.');
  if(typeof p.pages!=='number'||!Number.isInteger(p.pages)||p.pages<1||p.pages>10000) throw new Error('VALIDATION_ERROR: 쪽수는 1~10,000 사이의 정수예요.');
  if(typeof p.requestId!=='string'||! /^[a-zA-Z0-9-]{16,80}$/.test(p.requestId)) throw new Error('VALIDATION_ERROR');
  return {requestId:p.requestId,startDate:start,finishDate:finish,title:text_(p.title,120,true),publisher:text_(p.publisher,80,false),pages:p.pages,impressions:text_(p.impressions,3000,false)};
}
// All user strings written using RAW Sheets API: formula-like input stays literal text.
function appendRaw_(name, values) {
  Sheets.Spreadsheets.Values.append({values:[values]}, props_().getProperty('SPREADSHEET_ID'), "'"+name+"'!A:A", {valueInputOption:'RAW',insertDataOption:'INSERT_ROWS'});
}
function saveRecord(token,payload) {
  return lock_(()=>{
    const s=auth_(token), p=record_(payload);
    limit_('RATE_WRITE_'+s[0],60,60);
    const all=rows_('Records'), duplicate=all.find(r=>r[1]===s[0]&&r[2]===p.requestId);
    if(duplicate) return journal_(s[0]); // Includes tombstones: a retry cannot resurrect a deletion.
    if(all.filter(r=>r[1]===s[0]&&r[10]!==true).length>=500) throw new Error('LIMIT: 기록이 500개예요. 선생님에게 알려 주세요.');
    appendRaw_('Records',[Utilities.getUuid(),s[0],p.requestId,p.startDate,p.finishDate,p.title,p.publisher,p.pages,p.impressions,new Date().toISOString(),false,new Date().toISOString(),p.requestId]);
    return journal_(s[0]);
  });
}
function updateRecord(token,id,payload) {
  return lock_(()=>{
    const student=auth_(token), p=record_(payload);
    limit_('RATE_WRITE_'+student[0],60,60);
    if(typeof id!=='string'||id.length>80) throw new Error('VALIDATION_ERROR');
    const all=rows_('Records'), i=all.findIndex(r=>r[0]===id&&r[1]===student[0]&&r[10]!==true);
    if(i<0) throw new Error('NOT_FOUND: 기록을 찾을 수 없어요. 목록을 새로 불러와 주세요.');
    const r=all[i];
    if(r[12]===p.requestId) return journal_(student[0]);
    if(payload.expectedUpdatedAt!==String(r[11]||r[9])) throw new Error('CONFLICT: 다른 화면에서 바뀐 기록이에요. 목록을 새로 불러온 뒤 다시 수정해 주세요.');
    const now=new Date(Math.max(Date.now(),new Date(r[11]||r[9]).getTime()+1)).toISOString();
    const values=[r[0],r[1],r[2],p.startDate,p.finishDate,p.title,p.publisher,p.pages,p.impressions,r[9],false,now,p.requestId];
    Sheets.Spreadsheets.Values.update({values:[values]},props_().getProperty('SPREADSHEET_ID'),'Records!A'+(i+2)+':M'+(i+2),{valueInputOption:'RAW'});
    return journal_(student[0]);
  });
}
function deleteRecord(token,id) {
  return lock_(()=>{
    const s=auth_(token); limit_('RATE_WRITE_'+s[0],60,60);
    if(typeof id!=='string'||id.length>80) throw new Error('VALIDATION_ERROR');
    const r=rows_('Records'),i=r.findIndex(v=>v[0]===id&&v[1]===s[0]);
    if(i>=0) sheet_('Records').getRange(i+2,11).setValue(true);
    return journal_(s[0]);
  });
}
function logout(token) {
  return lock_(()=>{
    if(typeof token==='string'&&token.length===72) {
      const h=hash_(token), rows=rows_('Sessions');
      for(let i=rows.length-1;i>=0;i--) if(equal_(rows[i][0],h)) sheet_('Sessions').deleteRow(i+2);
    }
    return {ok:true};
  });
}
function pruneSessions_() {
  const rows=rows_('Sessions'), sheet=sheet_('Sessions');
  for(let i=rows.length-1;i>=0;i--) if(Number(rows[i][3])<=Date.now()) sheet.deleteRow(i+2);
}
/** Run once from editor. Set SPREADSHEET_ID in Script Properties first. */
function setup_() {
  lock_(()=>{
    const p=props_();
    if(!p.getProperty('AUTH_PEPPER')) p.setProperty('AUTH_PEPPER',Utilities.getUuid()+Utilities.getUuid()+Utilities.getUuid());
    const db=db_();
    Object.keys(HEADERS_).forEach(name=>{
      let s=db.getSheetByName(name);
      if(!s) s=db.insertSheet(name);
      if(s.getLastRow()===0) {s.appendRow(HEADERS_[name]);s.setFrozenRows(1);}
      else if(JSON.stringify(s.getRange(1,1,1,HEADERS_[name].length).getValues()[0])!==JSON.stringify(HEADERS_[name])) throw new Error('기존 시트의 열 구성이 다릅니다: '+name);
    });
  });
}
/** Set NEW_NAME, NEW_SALT, NEW_PROOF properties using local provision.html. Never place credentials in code. */
function provisionStudent_() {
  lock_(()=>{
    const p=props_(),n=name_(p.getProperty('NEW_NAME')), salt=p.getProperty('NEW_SALT'),proof=p.getProperty('NEW_PROOF');
    if(!/^[a-f0-9]{32}$/.test(salt||'')||!/^[a-f0-9]{64}$/.test(proof||'')) throw new Error('발급 도구의 salt/proof를 확인하세요.');
    if(student_(n)) throw new Error('이미 등록된 로그인 이름입니다. 동명이인은 반/번호를 덧붙여 주세요.');
    appendRaw_('Students',[Utilities.getUuid(),n,salt,hmac_('proof:'+salt+':'+proof),true,1]);
    ['NEW_NAME','NEW_SALT','NEW_PROOF'].forEach(k=>p.deleteProperty(k));
  });
}
/** Same temporary properties as provisioning. Existing sessions revoked via version bump. */
function resetStudentPassword_() {
  lock_(()=>{
    const p=props_(), n=name_(p.getProperty('NEW_NAME')),salt=p.getProperty('NEW_SALT'),proof=p.getProperty('NEW_PROOF');
    if(!/^[a-f0-9]{32}$/.test(salt||'')||!/^[a-f0-9]{64}$/.test(proof||'')) throw new Error('발급 값이 올바르지 않습니다.');
    const all=rows_('Students'),i=all.findIndex(s=>s[1]===n);
    if(i<0) throw new Error('학생을 찾지 못했습니다.');
    Sheets.Spreadsheets.Values.update({values:[[salt,hmac_('proof:'+salt+':'+proof),true,Number(all[i][5])+1]]}, p.getProperty('SPREADSHEET_ID'), 'Students!C'+(i+2)+':F'+(i+2), {valueInputOption:'RAW'});
    p.deleteProperty('RATE_LOGIN_'+all[i][0]);
    ['NEW_NAME','NEW_SALT','NEW_PROOF'].forEach(k=>p.deleteProperty(k));
  });
}
