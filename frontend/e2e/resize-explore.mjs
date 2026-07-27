// Exploratory harness: characterise how the shared zellij grid behaves when a
// laptop-sized and a phone-sized Porterminal client both view the SAME zellij
// session (resize-lab). Prints browser-side grid + ground-truth zellij client
// winsizes at each stage. Dump-only (no assertions) — this is for observation.
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';

const APP_URL = process.env.PTN_URL || 'http://127.0.0.1:9455/?e2e=1';
const SESSION = process.env.SESSION || 'resize-lab';
const HERE = new URL('.', import.meta.url).pathname;

function probe(label) {
    let out = '';
    try {
        out = execSync(`python3 ${HERE}/probe_clients.py 9455`, { encoding: 'utf8' });
    } catch (e) {
        out = '    [probe failed] ' + e.message;
    }
    console.log(`\n== ${label} ==`);
    process.stdout.write(out);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function connect(viewport, label, mobile) {
    const context = await browser.newContext({
        viewport,
        hasTouch: !!mobile,
        isMobile: !!mobile,
        deviceScaleFactor: mobile ? 3 : 1,
    });
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error') console.log(`  [${label} console.error] ${m.text()}`); });
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ptn?.getActiveTerminal?.(), { timeout: 15000 }).catch(() => {});
    // wait for a shell prompt to render
    await page.waitForFunction(() => {
        const t = window.__ptn?.getActiveTerminal?.(); if (!t) return false;
        const b = t.buffer.active;
        for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l && l.translateToString(true).trim()) return true; }
        return false;
    }, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);
    return { context, page, label };
}

async function state(c) {
    return await c.page.evaluate(() => window.__ptn.getGrid());
}

async function report(c, note) {
    const s = await state(c);
    const lock = s.fixedGrid ? `${s.fixedGrid.cols}x${s.fixedGrid.rows}` : 'none';
    console.log(`  [${c.label}] browser grid = ${s.cols}x${s.rows}  lock=${lock}  tabs=${s.tabCount}${note ? '  (' + note + ')' : ''}`);
}

async function typeCmd(c, cmd) {
    // real input down the data plane (onData path) via the ?e2e hook
    await c.page.evaluate((line) => window.__ptn.sendInput(line + '\r'), cmd);
}

console.log(`URL=${APP_URL} SESSION=${SESSION}`);
probe('0. baseline (before any client)');

// ---- laptop connects and attaches ------------------------------------------
const laptop = await connect({ width: 1600, height: 900 }, 'laptop', false);
await report(laptop, 'just connected, plain shell');
probe('1. laptop connected (plain shell PTY)');

await typeCmd(laptop, `zellij attach ${SESSION}`);
await laptop.page.waitForTimeout(3000);
await report(laptop, 'after attaching zellij');
probe('2. laptop attached to zellij');

// ---- phone connects (SHARED tab first) -------------------------------------
const phone = await connect({ width: 390, height: 844 }, 'phone', true);
await report(phone, 'just connected — does it share laptop tab?');
await report(laptop, 're-check laptop after phone connected');
probe('3. phone connected (shared-tab scenario A)');

// ---- phone gets its OWN tab and attaches (scenario B: two PTYs) -------------
await phone.page.evaluate(() => document.querySelector('#tab-bar .tab-add')?.click());
await phone.page.waitForTimeout(1500);
await report(phone, 'after opening its own tab');
await typeCmd(phone, `zellij attach ${SESSION}`);
await phone.page.waitForTimeout(3000);
await report(phone, 'after phone attaches zellij (own PTY)');
await report(laptop, 'LAPTOP after phone attached on its own PTY  <-- did it shrink?');
probe('4. phone attached on its OWN PTY (scenario B: two zellij clients)');

console.log('\n(leaving browsers open 2s for a final probe)');
await phone.page.waitForTimeout(500);
probe('5. final');

await browser.close();
console.log('\nDONE');
