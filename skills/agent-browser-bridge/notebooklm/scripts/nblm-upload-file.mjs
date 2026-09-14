const token=process.env.BRIDGE_TOKEN; const tabId=Number(process.argv[2]); const file=process.argv[3];
const BASE="http://127.0.0.1:8778/rpc";
async function rpc(m,p,t=30000){const r=await fetch(BASE,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({method:m,params:p,timeoutMs:t})});const j=await r.json();if(!j.ok)throw new Error(`${m}: ${JSON.stringify(j.error||j)}`);return j.result;}
async function send(me,p,t=30000){return (await rpc("session.send",{tabId,method:me,params:p},t)).result;}
(async()=>{
await rpc("session.attach",{tabId},15000);
try{
  // 点上传, 等 input 出现
  await send("Runtime.evaluate",{expression:`(()=>{const ov=document.querySelector('.cdk-overlay-container');const b=ov&&[...ov.querySelectorAll('button')].find(e=>/上传文件/.test(e.innerText||''));if(b)b.click();return 'clicked'})()`,returnByValue:true,userGesture:true});
  await new Promise(r=>setTimeout(r,3000));
  const {root}=await send("DOM.getDocument",{depth:-1});
  const {nodeId}=await send("DOM.querySelector",{nodeId:root.nodeId,selector:"input[type=file]"});
  if(!nodeId){console.log("✗ 无 file input");return;}
  console.log("✓ nodeId:",nodeId);
  await send("DOM.setFileInputFiles",{files:[file],nodeId},30000);
  console.log("✓ 已注入:",file);
  // 等上传处理
  for(let i=0;i<10;i++){
    await new Promise(r=>setTimeout(r,3000));
    const r=await send("Runtime.evaluate",{expression:"document.body.innerText.slice(0,250)",returnByValue:true});
    const t=r.result?.value||"";
    if(!/将文件拖到此处/.test(t)){ console.log("页面变化:", JSON.stringify(t.slice(0,200))); }
    if(/\.png|\.mp3|\.mp4|已添加|处理/i.test(t)) { console.log("✓ 检测到上传迹象"); break; }
  }
}finally{await rpc("session.detach",{tabId},10000).catch(()=>{});}
})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
