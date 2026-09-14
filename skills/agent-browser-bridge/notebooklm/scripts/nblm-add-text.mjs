const token=process.env.BRIDGE_TOKEN; const tabId=Number(process.argv[2]); const text=process.argv[3];
const BASE="http://127.0.0.1:8778/rpc";
async function rpc(m,p,t=30000){const r=await fetch(BASE,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({method:m,params:p,timeoutMs:t})});const j=await r.json();if(!j.ok)throw new Error(`${m}: ${JSON.stringify(j.error||j)}`);return j.result;}
async function send(me,p,t=30000){return (await rpc("session.send",{tabId,method:me,params:p},t)).result;}
async function ev(e,t=30000){const r=await send("Runtime.evaluate",{expression:e,returnByValue:true,userGesture:true},t);if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||"eval");return r.result?.value;}
(async()=>{
await rpc("session.attach",{tabId},15000);
try{
  // 1. 打开添加来源
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].filter(x=>/添加来源/.test(x.innerText||''));const t=b[b.length-1];if(t)t.click();return 'add clicked'})()`);
  await new Promise(x=>setTimeout(x,2500));
  // 2. 点 复制的文字
  await ev(`(()=>{const ov=document.querySelector('.cdk-overlay-container');const b=ov&&[...ov.querySelectorAll('button')].find(e=>/复制的文字/.test(e.innerText||''));if(b){b.click();return 'paste clicked'}return 'nf'})()`);
  await new Promise(x=>setTimeout(x,2500));
  // 3. 填 textarea
  const r=await ev(`(()=>{
    const ta=document.querySelector('textarea.copied-t')||document.querySelector('textarea[placeholder*="粘贴"]');
    if(!ta) return 'no textarea; all='+[...document.querySelectorAll('textarea')].map(t=>t.placeholder).join('|');
    const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    return 'filled '+ta.value.length;
  })()`);
  console.log("填充:",r);
  await new Promise(x=>setTimeout(x,1500));
  // 4. 点 插入
  const ins=await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/^\\s*插入\\s*$/.test(e.innerText||''));if(!b)return 'no insert';b.click();return 'inserted'})()`);
  console.log(ins);
  await new Promise(x=>setTimeout(x,6000));
  const st=await ev(`document.body.innerText.slice(0,300)`);
  console.log("结果:",JSON.stringify(st));
}finally{await rpc("session.detach",{tabId},10000).catch(()=>{});}
})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
