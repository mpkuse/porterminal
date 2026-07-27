// Regression checks for the "largest client wins" shared-size authority.
//
// Three Porterminal clients (laptop > tablet > phone) attach the SAME zellij
// session, each on its own tab/PTY. The largest must drive the grid unchanged
// while the smaller ones lock to it and scale locally — the laptop is never
// shrunk by a phone. Also exercises the zellij tab-nav buttons on the phone.
//
// Run via: SESSION=<a live zellij session> node resize-authority.e2e.mjs
// (defaults to resize-lab). Requires the ?e2e build hook and a running server.
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';

const APP_URL = process.env.PTN_URL || 'http://127.0.0.1:9455/?e2e=1';
const SESSION = process.env.SESSION || 'resize-lab';
const HERE = new URL('.', import.meta.url).pathname;

const results = [];
const check = (name, pass, detail = '') => {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

function e2eClients() {
    // [{cols,rows}] of zellij clients under the e2e server (winsize "CxR").
    try {
        const out = execSync(`python3 ${HERE}/probe_clients.py 9455`, { encoding: 'utf8' });
        return out.split('\n')
            .filter((l) => l.includes('[E2E]'))
            .map((l) => (l.match(/winsize=(\d+)x(\d+)/) || []).slice(1, 3).map(Number))
            .filter((p) => p.length === 2)
            .map(([cols, rows]) => ({ cols, rows }));
    } catch {
        return [];
    }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function connect(viewport, label, mobile) {
    const context = await browser.newContext({
        viewport, hasTouch: !!mobile, isMobile: !!mobile, deviceScaleFactor: mobile ? 3 : 1,
    });
    const page = await context.newPage();
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ptn?.getActiveTerminal?.(), { timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() => {
        const t = window.__ptn?.getActiveTerminal?.(); if (!t) return false;
        const b = t.buffer.active;
        for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l && l.translateToString(true).trim()) return true; }
        return false;
    }, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);
    return { context, page, label };
}

const grid = (c) => c.page.evaluate(() => window.__ptn.getGrid());
async function ownTab(c) { await c.page.evaluate(() => document.querySelector('#tab-bar .tab-add')?.click()); await c.page.waitForTimeout(1200); }
async function attach(c) {
    await c.page.evaluate((s) => window.__ptn.sendInput(`zellij attach ${s}\r`), SESSION);
    await c.page.waitForTimeout(2800);
}

// ---- attach laptop (largest) -----------------------------------------------
const laptop = await connect({ width: 1600, height: 900 }, 'laptop', false);
await attach(laptop);
const laptopGrid = await grid(laptop);
check('laptop is the unlocked driver after attach', laptopGrid.fixedGrid === null,
    `grid=${laptopGrid.cols}x${laptopGrid.rows} lock=${JSON.stringify(laptopGrid.fixedGrid)}`);

// ---- attach tablet (own tab) -----------------------------------------------
const tablet = await connect({ width: 1024, height: 768 }, 'tablet', true);
await ownTab(tablet);
await attach(tablet);
const laptopAfterTablet = await grid(laptop);
const tabletGrid = await grid(tablet);
check('laptop grid unchanged after tablet joins',
    laptopAfterTablet.cols === laptopGrid.cols && laptopAfterTablet.rows === laptopGrid.rows,
    `${laptopGrid.cols}x${laptopGrid.rows} -> ${laptopAfterTablet.cols}x${laptopAfterTablet.rows}`);
check('tablet locks to the laptop grid (scales locally)',
    tabletGrid.fixedGrid && tabletGrid.fixedGrid.cols === laptopGrid.cols && tabletGrid.fixedGrid.rows === laptopGrid.rows,
    `lock=${JSON.stringify(tabletGrid.fixedGrid)}`);

// ---- attach phone (own tab) ------------------------------------------------
const phone = await connect({ width: 390, height: 844 }, 'phone', true);
await ownTab(phone);
await attach(phone);
const laptopAfterPhone = await grid(laptop);
const phoneGrid = await grid(phone);
check('laptop grid STILL unchanged after phone joins (not shrunk)',
    laptopAfterPhone.cols === laptopGrid.cols && laptopAfterPhone.rows === laptopGrid.rows,
    `${laptopGrid.cols}x${laptopGrid.rows} -> ${laptopAfterPhone.cols}x${laptopAfterPhone.rows}`);
check('phone locks to the laptop grid (scales locally)',
    phoneGrid.fixedGrid && phoneGrid.fixedGrid.cols === laptopGrid.cols && phoneGrid.fixedGrid.rows === laptopGrid.rows,
    `lock=${JSON.stringify(phoneGrid.fixedGrid)}`);

// ---- backend ground truth: every zellij client sits at the laptop grid -----
const clients = e2eClients();
check('all zellij clients pinned to the laptop grid (no shrink)',
    clients.length >= 3 && clients.every((c) => c.cols === laptopGrid.cols && c.rows === laptopGrid.rows),
    JSON.stringify(clients));

// ---- zellij tab-nav buttons on the phone (zoom-independent switching) -------
const navVisible = await phone.page.evaluate(() => {
    const p = document.getElementById('btn-tab-prev');
    const n = document.getElementById('btn-tab-next');
    return !!p && !p.hidden && !!n && !n.hidden;
});
check('zellij tab-nav buttons are visible while locked', navVisible);
await phone.page.evaluate(() => document.getElementById('btn-tab-next')?.click());
await phone.page.waitForTimeout(300);
const stillFixed = (await grid(phone)).fixedGrid !== null;
check('tab-nav keeps the phone in fixed grid', stillFixed, `fixed=${stillFixed}`);

console.log('\n================ SUMMARY ================');
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
