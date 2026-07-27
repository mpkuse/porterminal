// Ad-hoc MOBILE inspection harness (not a pass/fail test).
// Drives a phone-emulated Chrome through every control and dumps geometry +
// screenshots so we can see the real mobile layout. Run:
//   PTN_URL='http://127.0.0.1:8199/?e2e=1' node inspect-mobile.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.PTN_URL || 'http://127.0.0.1:8199/?e2e=1';
const OUT = process.env.OUT || '/tmp/claude-1000/-home-manoharkuse--bin/235aaa68-36c7-46e7-8040-fbe89dea0526/scratchpad/shots';
mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(...a);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
});
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ptn?.getActiveTerminal?.(), { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(800);
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

// ---- helper: inventory of controls with visibility + rect --------------------
async function inventory(label) {
    const data = await page.evaluate(() => {
        const ids = ['btn-textview','btn-tab-prev','btn-tab-next','btn-reset-view','btn-font-down',
            'btn-font-up','btn-snippets','btn-compose','btn-settings','btn-info','btn-shutdown'];
        const vis = (el) => {
            if (!el) return {exists:false};
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            const onscreen = r.width>0 && r.height>0 && r.right>0 && r.left<innerWidth && r.bottom>0 && r.top<innerHeight;
            return {exists:true, hidden: el.hidden, display: cs.display, text: (el.textContent||'').trim().slice(0,8),
                x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), onscreen};
        };
        const out = {};
        for (const id of ids) out[id] = vis(document.getElementById(id));
        // tabs
        const tabBar = document.getElementById('tab-bar');
        const tabs = [...document.querySelectorAll('.tab-btn:not(.tab-add)')].map(vis);
        const add = vis(document.querySelector('.tab-add'));
        const tbr = tabBar?.getBoundingClientRect();
        return { controls: out, tabBar: tbr && {x:Math.round(tbr.left),w:Math.round(tbr.width),scrollW: tabBar.scrollWidth, clientW: tabBar.clientWidth},
            tabs, add, innerWidth: window.innerWidth };
    });
    log(`\n===== ${label} =====`);
    log(JSON.stringify(data, null, 1));
    return data;
}

await shot('01-initial');
await inventory('INITIAL (non-zellij, 1 tab)');

// ---- TAB OPEN UX: add tabs, is it obvious? -----------------------------------
await page.locator('.tab-add').tap();
await page.waitForTimeout(500);
await page.locator('.tab-add').tap();
await page.waitForTimeout(500);
await shot('02-three-tabs');
const afterAdd = await page.evaluate(() => ({
    tabCount: window.__ptn.getGrid().tabCount,
    activeTabText: document.querySelector('.tab-btn.active .tab-label')?.textContent,
    toastLike: [...document.querySelectorAll('body *')].filter(e=>{const t=(e.className||'').toString();return /toast|snackbar|float|notice|message/i.test(t);}).map(e=>e.className),
}));
log('\n===== AFTER ADDING 2 TABS ====='); log(JSON.stringify(afterAdd, null, 1));

// ---- ZELLIJ STATE: do the number tabs stay visible next to < > ? -------------
await page.evaluate(() => window.__ptn.enterFixedGrid(120, 30));
await page.waitForTimeout(600);
await shot('03-zellij-fixedgrid');
await inventory('ZELLIJ FIXED-GRID (nav < > visible)');

// ---- READ MODE: colors, display, scroll --------------------------------------
// Inject deterministic colored + long content.
await page.evaluate(async () => {
    const term = window.__ptn.getActiveTerminal();
    await new Promise(r => term.write('\x1b[2J\x1b[H', r));
    let s = '';
    for (let i = 1; i <= 80; i++) {
        s += `\x1b[3${i%7+1}mline ${i} colored \x1b[1;33mYELLOW\x1b[0m plain ${'pad'.repeat(20)}\r\n`;
    }
    await new Promise(r => term.write(s, r));
});
await page.waitForTimeout(300);
await page.locator('#btn-textview').tap();
await page.waitForTimeout(400);
await shot('04-read-open');
const readState = await page.evaluate(() => {
    const b = document.getElementById('textview-body');
    const cs = getComputedStyle(b);
    const overlay = document.getElementById('textview-overlay');
    return {
        overlayHidden: overlay.classList.contains('hidden'),
        chars: b.textContent.length,
        color: cs.color, background: cs.backgroundColor, whiteSpace: cs.whiteSpace,
        clientH: b.clientHeight, scrollH: b.scrollHeight, offsetH: b.offsetHeight,
        overflowY: cs.overflowY, canScroll: b.scrollHeight > b.clientHeight + 2,
        anyColoredSpans: b.querySelectorAll('span,font').length,
    };
});
log('\n===== READ MODE state ====='); log(JSON.stringify(readState, null, 1));

// try to scroll: wheel + touch drag
const scrollTest = await page.evaluate(async () => {
    const b = document.getElementById('textview-body');
    const before = b.scrollTop;
    b.dispatchEvent(new WheelEvent('wheel', {deltaY: 300, bubbles:true, cancelable:true}));
    await new Promise(r=>setTimeout(r,100));
    const afterWheel = b.scrollTop;
    // programmatic
    b.scrollTop = 200;
    await new Promise(r=>setTimeout(r,50));
    const afterSet = b.scrollTop;
    return { before, afterWheel, afterSet, scrollH: b.scrollHeight, clientH: b.clientHeight };
});
log('\n===== READ scroll test ====='); log(JSON.stringify(scrollTest, null, 1));
// touch drag scroll via playwright
try {
    const box = await page.locator('#textview-body').boundingBox();
    if (box) {
        const cx = box.x + box.width/2;
        await page.touchscreen.tap(cx, box.y + box.height*0.7);
        // simulate drag up
        await page.evaluate(async ([x0,y0,y1]) => {
            const b = document.getElementById('textview-body');
            const t = (type, y) => b.dispatchEvent(new TouchEvent(type, {bubbles:true, cancelable:true,
                touches: type==='touchend'?[]:[new Touch({identifier:1, target:b, clientX:x0, clientY:y})]}));
            const start = b.scrollTop;
            t('touchstart', y0); for(let y=y0;y>=y1;y-=20){ t('touchmove', y); await new Promise(r=>setTimeout(r,10)); } t('touchend', y1);
            window.__dragResult = {start, end: b.scrollTop};
        }, [cx, box.y+box.height*0.8, box.y+box.height*0.2]);
        const drag = await page.evaluate(() => window.__dragResult);
        log('touch-drag scroll:', JSON.stringify(drag));
    }
} catch(e){ log('touch drag err', e.message); }
await shot('05-read-scrolled');
await page.locator('#textview-close').tap();
await page.waitForTimeout(200);

// ---- OVERLAY BUTTON SWEEP (skip shutdown) ------------------------------------
for (const [id, name] of [['btn-snippets','snippets'],['btn-settings','settings'],['btn-info','help']]) {
    await page.locator('#'+id).tap();
    await page.waitForTimeout(400);
    await shot(`06-${name}`);
    // close via any visible close button
    await page.evaluate(() => {
        for (const s of ['#snippets-close','#settings-close','#help-close']) document.querySelector(s)?.click();
    });
    await page.waitForTimeout(300);
}

log('\n===== CONSOLE ERRORS ====='); log(consoleErrors.join('\n') || '(none)');
await browser.close();
process.exit(0);
