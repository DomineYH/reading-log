// Independent VM tests. Mocked Google services: not a deployment/integration test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(require('node:path').join(__dirname,'../apps-script/Code.gs'),'utf8');
function harness() {
  const data={Students:[],Records:[],Sessions:[]}, properties={SPREADSHEET_ID:'synthetic-db'};
  let locked=false;
  function sheet(name) { return {
    getDataRange:()=>({getValues:()=>data[name].map(r=>r.slice())}),
    getLastRow:()=>data[name].length,
    appendRow:r=>data[name].push(r.slice()), setFrozenRows:()=>{},
    deleteRow:r=>data[name].splice(r-1,1),
    getRange:(row,col,nr=1,nc=1)=>({
      getValues:()=>data[name].slice(row-1,row-1+nr).map(r=>r.slice(col-1,col-1+nc)),
      setValue:value=>{ data[name][row-1][col-1]=value; },
      setValues:values=>values.forEach((r,ri)=>r.forEach((v,ci)=>{data[name][row-1+ri][col-1+ci]=v;}))
    })
  }; }
  const db={getSheetByName:n=>data[n]?sheet(n):null,insertSheet:n=>{data[n]=[];return sheet(n);}};
  const context=vm.createContext({Date,JSON,Number,String,Object,Math,Error,
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties[k]??null,setProperty:(k,v)=>{properties[k]=v;},deleteProperty:k=>{delete properties[k];}})},
    SpreadsheetApp:{openById:()=>db},
    LockService:{getScriptLock:()=>({tryLock:()=>{assert.equal(locked,false);locked=true;return true;},releaseLock:()=>{locked=false;}})},
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},getUuid:()=>crypto.randomUUID(),
      computeDigest:(_,s)=>Array.from(crypto.createHash('sha256').update(s).digest()),
      computeHmacSha256Signature:(s,k)=>Array.from(crypto.createHmac('sha256',k).update(s).digest()),
      formatDate:()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())},
    Sheets:{Spreadsheets:{Values:{append:(body,id,range,options)=>{assert.equal(options.valueInputOption,'RAW');data[range.match(/^'([^']+)'/)[1]].push(...body.values);},
      update:(body,id,range,options)=>{assert.equal(options.valueInputOption,'RAW');const m=range.match(/^'?([^'!]+)'?!([A-Z]+)(\d+)/);const col=m[2].split('').reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);sheet(m[1]).getRange(Number(m[3]),col).setValues(body.values);}}}}
  });
  vm.runInContext(source,context);context.setup_();
  function user(name) { const salt=crypto.randomBytes(16).toString('hex'), proof=crypto.randomBytes(32).toString('hex');Object.assign(properties,{NEW_NAME:name,NEW_SALT:salt,NEW_PROOF:proof});context.provisionStudent_();return {name,salt,proof,token:context.login(name,proof).token};}
  const payload=(overrides={})=>({requestId:crypto.randomUUID(),startDate:'2026-01-01',finishDate:'2026-01-02',title:'Synthetic book',publisher:'Synthetic publisher',pages:37,impressions:'Synthetic impression',...overrides});
  return {c:context,data,properties,user,payload};
}
test('only intended RPCs are exposed; administrative helpers are private',()=>{
  const names=[...source.matchAll(/^function (\w+)\(/gm)].map(m=>m[1]).filter(n=>!n.endsWith('_'));
  assert.deepEqual(names.sort(),['doGet','getLoginChallenge','login','getJournal','saveRecord','updateRecord','deleteRecord','logout'].sort());
});
test('own-record isolation, client ID tampering, deletion isolation, and totals',()=>{
  const h=harness(),a=h.user('Synthetic A'),b=h.user('Synthetic B');
  const one=h.c.saveRecord(a.token,h.payload({studentId:h.data.Students[2][0]}));
  assert.equal(one.totalPages,37);assert.equal(h.c.getJournal(b.token).records.length,0);
  h.c.deleteRecord(b.token,one.records[0].id);assert.equal(h.c.getJournal(a.token).records.length,1);
  h.c.saveRecord(a.token,h.payload({finishDate:'',pages:90}));assert.equal(h.c.getJournal(a.token).totalPages,127);
  h.c.deleteRecord(a.token,one.records[0].id);assert.equal(h.c.getJournal(a.token).totalPages,90);
});
test('request retries are idempotent even after deletion',()=>{
  const h=harness(),a=h.user('Synthetic A'),p=h.payload();const first=h.c.saveRecord(a.token,p);
  h.c.saveRecord(a.token,p);assert.equal(h.data.Records.length,2);
  h.c.deleteRecord(a.token,first.records[0].id);assert.equal(h.c.saveRecord(a.token,p).records.length,0);
});
test('formula-like input stays literal at the RAW API boundary',()=>{
  const h=harness(),a=h.user('=Synthetic Name');
  const p=h.payload({title:'=IMPORTXML("https://example.invalid","//x")',publisher:'+123',impressions:'@SUM(1+1)'});
  const result=h.c.saveRecord(a.token,p);assert.equal(result.records[0].title,p.title);assert.equal(h.data.Records[1][5],p.title);
});
test('forged, expired, revoked, disabled, and version-invalid tokens fail closed',()=>{
  const h=harness(),a=h.user('Synthetic A');assert.throws(()=>h.c.getJournal('a'.repeat(72)),/AUTH_REQUIRED/);
  h.data.Sessions[1][3]=0;assert.throws(()=>h.c.getJournal(a.token),/AUTH_REQUIRED/);
  const t=h.c.login(a.name,a.proof).token;h.data.Students[1][4]=false;assert.throws(()=>h.c.getJournal(t),/AUTH_REQUIRED/);
  h.data.Students[1][4]=true;h.data.Students[1][5]++;assert.throws(()=>h.c.getJournal(t),/AUTH_REQUIRED/);
  const t2=h.c.login(a.name,a.proof).token;h.c.logout(t2);assert.throws(()=>h.c.saveRecord(t2,h.payload()),/AUTH_REQUIRED/);
});
test('password reset invalidates old proof and outstanding sessions',()=>{
  const h=harness(),a=h.user('Synthetic A'),salt=crypto.randomBytes(16).toString('hex'),proof=crypto.randomBytes(32).toString('hex');
  Object.assign(h.properties,{NEW_NAME:a.name,NEW_SALT:salt,NEW_PROOF:proof});h.c.resetStudentPassword_();
  assert.throws(()=>h.c.getJournal(a.token),/AUTH_REQUIRED/);assert.throws(()=>h.c.login(a.name,a.proof),/LOGIN_FAILED/);
  assert.ok(h.c.login(a.name,proof).token);assert.equal(h.properties.NEW_PROOF,undefined);
});
test('persistent throttling is bounded for unknown names',()=>{
  const h=harness();for(let i=0;i<120;i++) assert.throws(()=>h.c.login('Unknown '+i,'0'.repeat(64)),/LOGIN_FAILED/);
  assert.throws(()=>h.c.login('Unknown 121','0'.repeat(64)),/RATE_LIMIT/);
  assert.equal(Object.keys(h.properties).filter(k=>k.startsWith('RATE_LOGIN')).length,1);
});
test('invalid dates, noninteger pages, huge text and request IDs are rejected',()=>{
  const h=harness(),a=h.user('Synthetic A');for(const changes of [{startDate:'2026-02-30'},{finishDate:'2025-12-31'},{pages:0},{pages:1.5},{pages:Infinity},{pages:'10'},{title:'x'.repeat(121)},{requestId:'short'},{impressions:'x'.repeat(3001)}]) assert.throws(()=>h.c.saveRecord(a.token,h.payload(changes)),/VALIDATION_ERROR/);
  assert.equal(h.data.Records.length,1);
});

test('editing enforces ownership, handles retries, rejects stale versions and deleted rows',()=>{
  const h=harness(),a=h.user('Synthetic A'),b=h.user('Synthetic B');
  const first=h.c.saveRecord(a.token,h.payload()).records[0];
  const edit=h.payload({title:'=1+1',pages:100,expectedUpdatedAt:first.updatedAt});
  assert.throws(()=>h.c.updateRecord(b.token,first.id,edit),/NOT_FOUND/);
  const updated=h.c.updateRecord(a.token,first.id,edit);
  assert.equal(updated.totalPages,100);assert.equal(updated.records[0].title,'=1+1');
  assert.notEqual(updated.records[0].updatedAt,first.updatedAt);
  const retry=h.c.updateRecord(a.token,first.id,edit);assert.equal(retry.records[0].updatedAt,updated.records[0].updatedAt);
  assert.throws(()=>h.c.updateRecord(a.token,first.id,h.payload({expectedUpdatedAt:first.updatedAt})),/CONFLICT/);
  h.c.deleteRecord(a.token,first.id);assert.throws(()=>h.c.updateRecord(a.token,first.id,edit),/NOT_FOUND/);
});
test('credential material and tokens are not stored in their reusable form',()=>{
  const h=harness(),a=h.user('Synthetic A'),b=h.user('Synthetic B');
  assert.notEqual(h.c.getLoginChallenge(a.name).salt,h.c.getLoginChallenge(b.name).salt);
  const unknown=h.c.getLoginChallenge('Synthetic Unknown');assert.match(unknown.salt,/^[a-f0-9]{32}$/);assert.equal(unknown.iterations,600000);
  const serialized=JSON.stringify(h.data);assert.equal(serialized.includes(a.proof),false);assert.equal(serialized.includes(a.token),false);
  assert.equal(h.properties.NEW_PROOF,undefined);assert.equal(h.properties.NEW_SALT,undefined);assert.equal(h.properties.NEW_NAME,undefined);
});
