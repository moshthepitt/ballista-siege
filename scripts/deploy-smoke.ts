import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { getAddressEncoder, address } from '@solana/kit';
import type { Browser, Page } from 'playwright-core';
import { TESTED_PROGRAM } from '../play/deployments/program.js';
import { BURNER_KEY, RPC_KEY, DEVNET_GENESIS } from '../play/network-state.js';

/** Runs through the Eyes smoke child, which can read the current script without restarting Eyes. */
export async function deploySmoke(browser: Browser, dist: string, audit: (page: Page, label: string) => Promise<void>): Promise<void> {
  const output = resolve('.tmp/dp1/browser'); await mkdir(output, { recursive: true });
  const report: Record<string, unknown> = {};
  const p = TESTED_PROGRAM, encode = getAddressEncoder(), program = new Uint8Array(36), data = new Uint8Array(45);
  new DataView(program.buffer).setUint32(0,2,true); program.set(encode.encode(address(p.programdata)),4);
  new DataView(data.buffer).setUint32(0,3,true); new DataView(data.buffer).setBigUint64(4,p.slot,true); data[12]=1; data.set(encode.encode(address(p.authority)),13);
  const mime: Record<string,string> = { '.html':'text/html','.js':'text/javascript','.woff2':'font/woff2','.txt':'text/plain' };
  for (const [width,height] of [[1920,950],[390,844]]) {
    const touch=width<600, tag=`${width}x${height}`;
    let savedSeed='';
    let upgraded=false;
    for (const returning of [false,true]) {
      if(returning)upgraded=false;
      const context=await browser.newContext({ viewport:{width,height}, hasTouch:touch, isMobile:touch, permissions:['clipboard-read','clipboard-write'] });
      const page=await context.newPage(), errors:string[]=[], requests: {url:string;interactive:boolean}[]=[], rpcCalls:string[]=[];
      await page.addInitScript('window.__name = (fn) => fn');
      if (returning) await page.addInitScript(({key,value})=>localStorage.setItem(key,value),{key:BURNER_KEY,value:savedSeed});
      await page.addInitScript(() => {
        const account={address:'A9TciQEkWp1uh8ee4DpPyXgi4twSfUuNFe9sGEvjxfsQ',chains:['solana:devnet'],features:['solana:signAndSendTransaction']};
        const wallet={name:'Fixture devnet wallet',chains:['solana:devnet'],accounts:[account],features:{
          'standard:connect':{version:'1.0.0',connect:async()=>({accounts:[account]})},
          'solana:signAndSendTransaction':{version:'1.0.0',supportedTransactionVersions:['legacy',0],signAndSendTransaction:async(input:{transaction:Uint8Array})=>{
            (window as typeof window & {fundTransfer?:number[]}).fundTransfer=Array.from(input.transaction); return [{signature:new Uint8Array(64)}];
          }},
        }};
        window.addEventListener('wallet-standard:app-ready',event=>(event as CustomEvent).detail.register(wallet));
      });
      page.on('pageerror',error=>errors.push(error.message));
      page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
      page.on('request',request=>{ if(request.url().startsWith('http://localhost/')) { const record={url:request.url(),interactive:false}; requests.push(record); void page.evaluate(()=>!!document.querySelector('[data-command=fight]:not([disabled])')).then(interactive=>{record.interactive=interactive;}).catch(()=>{}); } });
      await page.route('http://localhost/**',async route=>{
        const path=new URL(route.request().url()).pathname;
        assert(path.startsWith('/siege/'),`Asset escaped Pages subpath: ${path}`);
        const local=resolve(dist,path==='/siege/'?'index.html':path.slice('/siege/'.length)); assert(local.startsWith(dist+sep));
        await route.fulfill({contentType:mime[extname(local)]??'application/octet-stream',body:await readFile(local)});
      });
      await context.route('https://faucet.solana.com/**', route=>route.fulfill({contentType:'text/html',body:'<title>Fixture faucet</title>'}));
      await page.route('https://**/*',async route=>{
        const body=route.request().postDataJSON() as {id:string;method:string;params?:unknown[]}; rpcCalls.push(body.method);
        const account=(bytes:Uint8Array,executable:boolean)=>({owner:p.loader,executable,lamports:1,rentEpoch:0,space:bytes.length,data:[Buffer.from(bytes).toString('base64'),'base64']});
        const values:Record<string,unknown>={getGenesisHash:new URL(route.request().url()).hostname==='wrong.example'?'wrong':DEVNET_GENESIS,getBalance:{context:{slot:1},value:12_000_000},getLatestBlockhash:{context:{slot:1},value:{blockhash:'11111111111111111111111111111111',lastValidBlockHeight:100}},getAccountInfo:{context:{slot:1},value:body.params?.[0]===p.address?account(program,true):account(upgraded ? (()=>{const changed=data.slice();new DataView(changed.buffer).setBigUint64(4,p.slot+1n,true);return changed;})() : data,false)}};
        const response=body.method==='requestAirdrop'?{jsonrpc:'2.0',id:body.id,error:{code:-32005,message:'Faucet busy'}}:{jsonrpc:'2.0',id:body.id,result:values[body.method]};
        await route.fulfill({contentType:'application/json',body:JSON.stringify(response)});
      });
      const click=async(selector:string)=>{const node=page.locator(selector).first();if(touch)await node.tap();else await node.click();};
      try {
        await page.goto('http://localhost/siege/?seed=4&tutorial=0&mute=1');
        await page.locator('[data-command=fight]:not([disabled])').waitFor(); await page.evaluate(()=>document.fonts.ready); await page.waitForTimeout(900);
        if(returning){
          await page.waitForFunction(()=>performance.getEntriesByType('resource').some(r=>r.name.includes('/network-')));
          assert(requests.some(r=>r.url.includes('/network-')&&r.interactive),'Returning chain chunk loaded before board interactivity');
          report[`${tag} returning`]={requests,errors}; assert.deepEqual(errors,[]); console.log(`PASS ${tag} returning burner: lazy chain after interactive board`); continue;
        }
        assert(!requests.some(r=>r.url.includes('/network-')),'Fresh visit loaded chain code'); assert.equal(rpcCalls.length,0);
        assert.equal(requests.length,4,'Fresh visit request count');
        report[`${tag} first`]={requests:[...requests],rpcCalls:[...rpcCalls]};
        await page.screenshot({path:resolve(output,`${tag}-build.png`)});
        // Layout fixture only: production without a manifest correctly remains Offline.
        await page.evaluate(()=>window.dispatchEvent(new CustomEvent('ballista:network',{detail:{label:'Devnet · 0.012 SOL',reason:''}})));
        await audit(page,`${tag} funded badge fixture`); await page.screenshot({path:resolve(output,`${tag}-funded-badge.png`)});
        if(touch){await click('.hud .status');await click('#sheet [data-command=fund]');}else await click('#chain-chip');
        await page.waitForFunction(()=>!!document.querySelector<HTMLInputElement>('#burner-address')?.value);
        await page.locator('.program-result').filter({hasText:'matches the tested build'}).waitFor();
        const burner=await page.locator('#burner-address').inputValue(); savedSeed=await page.evaluate(key=>localStorage.getItem(key)!,BURNER_KEY);
        assert.equal(JSON.parse(savedSeed).length,32); assert.equal(await page.locator('.fund-balance').innerText(),'0.012 SOL');
        await audit(page,`${tag} Fund`); await page.screenshot({path:resolve(output,`${tag}-fund.png`)});
        await click('[data-fund=copy]'); assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),burner);
        const popupReady=page.waitForEvent('popup'); await click('[data-fund=faucet]'); const popup=await popupReady; await popup.waitForURL('https://faucet.solana.com/'); await popup.close(); await page.bringToFront(); assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),burner);
        await click('[data-fund=airdrop]'); await page.locator('.fund-message').filter({hasText:'Faucet busy'}).waitFor(); await page.waitForTimeout(500); assert.equal(rpcCalls.filter(m=>m==='requestAirdrop').length,1);
        await click('[data-fund=wallet]'); await page.locator('.fund-message').filter({hasText:'Transfer sent'}).waitFor();
        const transfer=await page.evaluate(()=>(window as typeof window & {fundTransfer?:number[]}).fundTransfer); assert(transfer&&transfer.length>100);
        assert(Buffer.from(transfer).includes(Buffer.from([2,0,0,0,0,45,49,1,0,0,0,0])),'Wallet transfer bytes differ');
        assert.equal(await page.evaluate(key=>localStorage.getItem(key),BURNER_KEY),savedSeed,'Funding replaced game signer');
        await click('#sheet details:first-of-type summary'); await click('[data-fund=export]'); const exported=await page.evaluate(()=>navigator.clipboard.readText()); assert.equal(JSON.parse(exported).length,64);
        const downloadReady=page.waitForEvent('download'); await click('[data-fund=download]'); const download=await downloadReady; const file=await download.path(); assert(file); assert.equal(await readFile(file,'utf8'),exported); await download.delete();
        await page.locator('#restore-key').fill(exported); await click('[data-fund=restore]'); await page.locator('.fund-message').filter({hasText:'Burner restored'}).waitFor(); assert.equal(await page.locator('#burner-address').inputValue(),burner);
        await audit(page,`${tag} backup`); await page.screenshot({path:resolve(output,`${tag}-backup.png`)});
        await click('#sheet details:last-of-type summary'); await page.locator('#rpc-endpoint').fill('https://wrong.example'); await click('[data-fund=rpc-save]'); await page.locator('.fund-message').filter({hasText:'not Solana devnet'}).waitFor(); assert.equal(await page.evaluate(key=>localStorage.getItem(key),RPC_KEY),null);
        await page.locator('#rpc-endpoint').fill('https://rpc.example'); await click('[data-fund=rpc-save]'); await page.waitForFunction(key=>localStorage.getItem(key)==='https://rpc.example/',RPC_KEY);
        await audit(page,`${tag} RPC`); await page.screenshot({path:resolve(output,`${tag}-rpc.png`)});
        upgraded=true; await click('[data-fund=refresh]'); await page.locator('.program-result').filter({hasText:'Ballista changed since this build was tested. Playing offline.'}).waitFor();
        await page.screenshot({path:resolve(output,`${tag}-program-changed.png`)}); await audit(page,`${tag} program changed`);
        assert.deepEqual(errors,[]); report[`${tag} controls`]={rpcCalls,errors,keyBytes:64,transferBytes:transfer.length,audit:'clean'};
        console.log(`PASS ${tag} first visit: 4 requests, zero chain; Fund, faucet refusal, wallet, key round trip, RPC policy, Pages subpath`);
      } finally { await context.close(); }
    }
  }
  await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));
}
