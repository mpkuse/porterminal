// Pinpoint the Read-mode touch-scroll fix using REAL CDP touch events.
import { chromium } from 'playwright';
const URL = process.env.PTN_URL || 'http://127.0.0.1:8199/?e2e=1';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport:{width:390,height:844}, hasTouch:true, isMobile:true, deviceScaleFactor:3 });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await page.goto(URL, { waitUntil:'domcontentloaded' });
await page.waitForFunction(() => window.__ptn?.getActiveTerminal?.(), {timeout:15000}).catch(()=>{});
await page.waitForTimeout(700);

// long content + open reader
await page.evaluate(async () => {
  const term = window.__ptn.getActiveTerminal();
  await new Promise(r=>term.write('\x1b[2J\x1b[H', r));
  let s=''; for(let i=1;i<=120;i++) s+=`row ${i} ................................\r\n`;
  await new Promise(r=>term.write(s, r));
});
await page.waitForTimeout(200);
await page.locator('#btn-textview').tap();
await page.waitForTimeout(300);
// scroll to top first so we can scroll down
await page.evaluate(() => { document.getElementById('textview-body').scrollTop = 0; });

async function touchDrag(fromY, toY) {
  const b = await page.locator('#textview-body').boundingBox();
  const x = b.x + b.width/2;
  await cdp.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{x, y:fromY}] });
  const steps = 8;
  for (let i=1;i<=steps;i++){
    const y = fromY + (toY-fromY)*i/steps;
    await cdp.send('Input.dispatchTouchEvent', { type:'touchMove', touchPoints:[{x, y}] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] });
  await page.waitForTimeout(150);
}
const st = () => page.evaluate(() => document.getElementById('textview-body').scrollTop);

async function trial(label) {
  await page.evaluate(() => { document.getElementById('textview-body').scrollTop = 0; });
  const before = await st();
  await touchDrag(600, 200); // drag finger UP => scroll down
  const after = await st();
  console.log(`${label}: scrollTop ${before} -> ${after}  (${after>before?'SCROLLED ✓':'blocked ✗'})`);
  return after > before;
}

await trial('BEFORE fix (current CSS)');

// candidate fixes, applied cumulatively
await page.evaluate(() => { document.getElementById('textview-body').style.touchAction = 'pan-y'; });
await trial('body{touch-action:pan-y}');

await page.evaluate(() => {
  document.getElementById('textview-overlay').style.touchAction = 'pan-y';
  document.getElementById('textview-content').style.touchAction = 'pan-y';
});
await trial('+ overlay/content pan-y');

await browser.close();
process.exit(0);
