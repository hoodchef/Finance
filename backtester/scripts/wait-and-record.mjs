/** Polls patiently until the rate limit clears, then records the fixtures. */
import { execSync } from 'node:child_process';
const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
for (let i=0;i<60;i++){
  try{
    const res=await fetch('https://query1.finance.yahoo.com/v8/finance/chart/SPY?period1=1704067200&period2=1706745600&interval=1d',{headers:{'User-Agent':UA}});
    console.log(`${new Date().toISOString()} probe ${i+1}: HTTP ${res.status}`);
    if(res.ok){
      console.log('rate limit cleared, recording fixtures');
      execSync('node scripts/record-fixtures.mjs',{stdio:'inherit'});
      break;
    }
  }catch(e){ console.log(`probe ${i+1}: ${e.message}`); }
  await sleep(120000);
}
