// Reproduce the user's real scenario: a NATIVE laptop client is already on a
// session; a phone-sized Porterminal client attaches. The native client must
// NOT shrink. Prints zellij client winsizes before/after.
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';

const APP_URL = 'http://127.0.0.1:9455/?e2e=1';
const SESSION = process.env.SESSION || 'sizelab';
const HERE = new URL('.', import.meta.url).pathname;
const NATIVE = process.env.NATIVE || '210x55'; // the laptop native client's grid

const probe = () => {
    try { return execSync(`python3 ${HERE}/probe_clients.py 9455`, { encoding: 'utf8' }); }
    catch (e) { return '  probe failed: ' + e.message; }
};
const nativeStillFull = (txt) => txt.split('\n').some((l) => l.includes('[other]') && l.includes(`winsize=${NATIVE}`));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
const page = await ctx.newPage();
await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ptn?.getActiveTerminal?.(), { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(600);

const before = probe();
console.log('== BEFORE phone attach ==\n' + before);
console.log(`native ${NATIVE} present before: ${nativeStillFull(before)}`);

// Type the attach, but inject cursor-key escapes (ESC) before Enter so the
// typed-input detector bails (command_tracking_valid=False) — the shell still
// runs the command. This isolates the client-presence SWEEP as the only thing
// that can protect the native client (mirrors tab-completion / paste starts).
await page.evaluate((s) => window.__ptn.sendInput(`zellij attach ${s}`), SESSION);
await page.evaluate(() => window.__ptn.sendInput('\x1b[D\x1b[C')); // Left, Right
await page.evaluate(() => window.__ptn.sendInput('\r'));
await page.waitForTimeout(4500); // allow attach + the ~1s sweep to reconcile

const g = await page.evaluate(() => window.__ptn.getGrid());
const after = probe();
console.log(`\nphone grid=${g.cols}x${g.rows}  lock=${JSON.stringify(g.fixedGrid)}`);
console.log('== AFTER phone attach ==\n' + after);

const pass = nativeStillFull(after)
    && g.fixedGrid && `${g.fixedGrid.cols}x${g.fixedGrid.rows}` === NATIVE;
console.log(`\n${pass ? 'PASS' : 'FAIL'}  native ${NATIVE} NOT shrunk by phone, phone locked to it`);
await browser.close();
process.exit(pass ? 0 : 1);
