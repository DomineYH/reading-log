const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../provision.html'),'utf8');
function harness(subtle=crypto.webcrypto.subtle){
  const nodes={};
  for(const id of ['form','name','password','generate','status','out','clear'])nodes[id]={value:'',hidden:false,textContent:'',disabled:false};
  nodes.form.reset=()=>{nodes.name.value='';nodes.password.value='';};
  const context=vm.createContext({document:{getElementById:id=>nodes[id]},crypto:{subtle,getRandomValues:a=>crypto.webcrypto.getRandomValues(a)},Uint8Array,Array,TextEncoder,Error});
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
  return nodes;
}
test('provision derives correct PBKDF2 proof and clears password/output',async()=>{
  const n=harness();n.name.value='가상학생-테스트';n.password.value='fictional-only-password';
  await n.form.onsubmit({preventDefault(){}});
  const salt=n.out.textContent.match(/NEW_SALT = ([a-f0-9]{32})/)[1];
  const proof=n.out.textContent.match(/NEW_PROOF = ([a-f0-9]{64})/)[1];
  assert.equal(proof,crypto.pbkdf2Sync('fictional-only-password',Buffer.from(salt,'hex'),600000,32,'sha256').toString('hex'));
  assert.equal(n.password.value,'');assert.equal(n.generate.disabled,false);
  n.clear.onclick();assert.equal(n.out.textContent,'');assert.equal(n.name.value,'');
});
test('provision clears password even when crypto fails and blocks network by CSP',async()=>{
  const n=harness(undefined); // explicitly replace subtle with failed implementation below
  const bad=harness({importKey:async()=>{throw Error('synthetic failure');}});
  bad.name.value='가상학생';bad.password.value='fictional-only-password';
  await bad.form.onsubmit({preventDefault(){}});
  assert.equal(bad.password.value,'');assert.equal(bad.status.textContent,'synthetic failure');
  assert.match(html,/default-src 'none'/);assert.match(html,/form-action 'none'/);
  assert.doesNotMatch(html,/fetch\(|XMLHttpRequest|localStorage|sessionStorage/);
});
