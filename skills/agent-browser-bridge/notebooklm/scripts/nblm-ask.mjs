const token=process.env.BRIDGE_TOKEN; const tabId=Number(process.argv[2]); const q=process.argv[3];
const BASE="http://127.0.0.1:8778/rpc";
async function rpc(m,p,t=30000){const r=await fetch(BASE,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({method:m,params:p,timeoutMs:t})});const j=await r.json();if(!j.ok)throw new Error(`${m}: ${JSON.stringify(j.error||j)}`);return j.result;}
async function send(me,p,t=30000){return (await rpc("session.send",{tabId,method:me,params:p},t)).result;}
async function ev(e,t=30000){const r=await send("Runtime.evaluate",{expression:e,returnByValue:true,userGesture:true},t);if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||"eval");return r.result?.value;}
(async()=>{
await rpc("session.attach",{tabId},15000);
try{
  await ev(`(()=>{const ta=document.querySelector('textarea[placeholder*="提问"]');if(!ta)return 'no ta';
    const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
    s.call(ta,${JSON.stringify(q)}); ta.dispatchEvent(new Event('input',{bubbles:true})); return 'q set'})()`);
  await new Promise(x=>setTimeout(x,1200));
  // 提交(按 Enter 或点 arrow_forward)
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/arrow_forward/.test(e.innerText||''));if(b){b.click();return 'sent'}return 'nf'})()`);
  console.log("已提问, 等待回答...");
  // 等待回答出现
  for(let i=0;i<12;i++){
    await new Promise(x=>setTimeout(x,4000));
    const a=await ev(`(()=>{const m=document.body.innerText; const i=m.indexOf('${q.slice(0,8)}'); if(i<0) return null; return m.slice(i, i+600)})()`);
    if(a && a.length>60){ console.log("回答:", JSON.stringify(a)); break; }
  }
}finally{await rpc("session.detach",{tabId},10000).catch(()=>{});}
})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
