import fs from 'node:fs/promises';
const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const toUnix=(d)=>Math.floor(Date.parse(`${d}T00:00:00Z`)/1000);
const TARGETS=[
  {symbol:'SPY',start:'2015-01-01',end:'2024-12-31',file:'spy-2015-2024.json'},
  {symbol:'BND',start:'2015-01-01',end:'2024-12-31',file:'bnd-2015-2024.json'},
];
for (const {symbol,start,end,file} of TARGETS){
  const qs=new URLSearchParams({period1:String(toUnix(start)),period2:String(toUnix(end)+86400),interval:'1d',events:'div,split',includeAdjustedClose:'true'});
  let ok=false;
  for (let a=0;a<25 && !ok;a++){
    const host=['query1','query2'][a%2];
    try{
      const res=await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${symbol}?${qs}`,{headers:{'User-Agent':UA,'Accept':'application/json'}});
      if(res.ok){
        const json=await res.json();
        await fs.writeFile(`tests/fixtures/${file}`,JSON.stringify(json),'utf8');
        const r=json.chart.result[0];
        console.log(`${symbol} OK -> ${file} ${r.timestamp.length} bars, ${Object.keys(r.events?.dividends??{}).length} divs`);
        ok=true;
      } else {
        console.log(`${symbol} attempt ${a+1}: HTTP ${res.status}`);
        await sleep(20000);
      }
    }catch(e){ console.log(`${symbol} attempt ${a+1}: ${e.message}`); await sleep(20000); }
  }
  if(!ok) console.log(`${symbol} FAILED`);
  await sleep(15000);
}
