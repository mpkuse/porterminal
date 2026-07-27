// Playwright gesture checks for Porterminal's touch scheme (docs/design/gestures.md).
// Drives real Chrome (channel: chrome) against a locally running server.
//
// Run via ./run.sh (starts a throwaway server + tears it down), or point at an
// already-running instance: PTN_URL='http://127.0.0.1:9444/?e2e=1' node gestures.e2e.mjs
//
// Requires the ?e2e test hook in the served build (main.ts, gated on ?e2e).
import { chromium } from 'playwright';

const URL = process.env.PTN_URL || 'http://127.0.0.1:9455/?e2e=1';
const results = [];
function check(name, pass, detail = '') {
    results.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
    permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded' });

// Wait for the terminal to boot and the test hook to appear.
await page.waitForFunction(() => {
    const w = window.__ptn;
    return w && typeof w.getActiveTerminal === 'function' && w.getActiveTerminal();
}, { timeout: 15000 }).catch(() => {});

const booted = await page.evaluate(() => Boolean(window.__ptn?.getActiveTerminal?.()));
check('app boots + terminal ready', booted);
if (!booted) {
    check('ABORT', false, 'terminal never became ready (is the server up and built with ?e2e hook?)');
    console.log('\nConsole errors:\n' + (consoleErrors.join('\n') || '(none)'));
    await browser.close();
    process.exit(1);
}

// Wait for the shell prompt to render + settle, THEN inject deterministic text
// (WebGL renderer has no DOM cells to target). Injecting after the prompt has
// arrived stops a late prompt from overwriting row 0 and racing the checks.
const bufHasText = () => page.evaluate(() => {
    const b = window.__ptn.getActiveTerminal().buffer.active;
    for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l && l.translateToString(true).trim()) return true; }
    return false;
});
await page.waitForFunction(() => {
    const b = window.__ptn.getActiveTerminal().buffer.active;
    for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l && l.translateToString(true).trim()) return true; }
    return false;
}, { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(500); // let a git-aware / multi-part prompt finish
async function injectText() {
    await page.evaluate(async () => {
        const term = window.__ptn.getActiveTerminal();
        await new Promise((r) => term.write('\x1b[2J\x1b[H', r));
        await new Promise((r) => term.write('SELECTONE SELECTTWO SELECTTHREE', r));
    });
    await page.waitForTimeout(150);
}
await injectText();
// If a late prompt still clobbered row 0, re-inject once.
if (!(await page.evaluate(() => window.__ptn.getActiveTerminal().buffer.active.getLine(0)?.translateToString(true).includes('SELECTONE')))) {
    await page.waitForTimeout(300);
    await injectText();
}
void bufHasText;

// Helpers injected into the page to dispatch synthetic touch/pointer events
// at a given terminal cell, plus geometry.
await page.addScriptTag({ content: `
window.__cell = (col, row) => {
    const term = window.__ptn.getActiveTerminal();
    const el = term.element;
    const rect = el.getBoundingClientRect();
    const cw = rect.width / term.cols;
    const ch = rect.height / term.rows;
    return { x: rect.left + (col + 0.5) * cw, y: rect.top + (row + 0.5) * ch, el };
};
window.__ptrDown = (x, y) => window.__cell(0,0).el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true }));
window.__ptrMove = (x, y) => window.__cell(0,0).el.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true }));
window.__ptrUp = (x, y) => window.__cell(0,0).el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true }));
window.__mkTouch = (id, x, y) => new Touch({ identifier: id, target: window.__cell(0,0).el, clientX: x, clientY: y, pageX: x, pageY: y });
window.__touch = (type, pts) => {
    const touches = pts.map((p, i) => window.__mkTouch(i, p.x, p.y));
    window.__cell(0,0).el.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: touches, bubbles: true, cancelable: true }));
};
// Two taps ~90ms apart, both dispatched in-page so the gap stays under the
// double-tap window (round-trips between separate evaluate() calls would drift).
window.__doubleTap = (x, y) => new Promise((resolve) => {
    window.__ptrDown(x, y); window.__ptrUp(x, y);
    setTimeout(() => { window.__ptrDown(x, y); window.__ptrUp(x, y); resolve(); }, 90);
});
` });

const barHidden = () => page.evaluate(() => document.getElementById('selection-bar')?.classList.contains('hidden') ?? true);
const barVisible = () => page.evaluate(() => window.__ptn.selectionBarVisible());
const handlesVisible = () => page.evaluate(() => {
    const s = document.querySelector('.sel-handle-start');
    const e = document.querySelector('.sel-handle-end');
    return Boolean(s && e && !s.classList.contains('hidden') && !e.classList.contains('hidden'));
});
const selection = () => page.evaluate(() => window.__ptn.getActiveTerminal().getSelection());

// ---- 1. Long-press grabs the word + shows the bar ---------------------------
const c3 = await page.evaluate(() => window.__cell(3, 0));   // inside "SELECTONE"
await page.evaluate(({ x, y }) => window.__ptrDown(x, y), c3);
await page.waitForTimeout(320);                              // > LONG_PRESS_MS (250)
const selAfterLongPress = await selection();
check('long-press selects the word', selAfterLongPress.includes('SELECTONE'), JSON.stringify(selAfterLongPress));
check('long-press shows the action bar', await barVisible() && !(await barHidden()));
check('long-press shows both handles', await handlesVisible());
await page.evaluate(({ x, y }) => window.__ptrUp(x, y), c3);
await page.waitForTimeout(50);
check('bar persists after finger lifts', await barVisible());

// ---- 2. Drag adjusts the selection (extend rightward) -----------------------
const cEnd = await page.evaluate(() => window.__cell(8, 0));   // near end of SELECTONE
const cFar = await page.evaluate(() => window.__cell(24, 0));  // into SELECTTHREE
await page.evaluate(({ x, y }) => window.__ptrDown(x, y), cEnd);
await page.evaluate(({ x, y }) => window.__ptrMove(x, y), { x: cEnd.x + 25, y: cEnd.y });
await page.evaluate(({ x, y }) => window.__ptrMove(x, y), cFar);
await page.waitForTimeout(30);
const selAfterDrag = await selection();
await page.evaluate(({ x, y }) => window.__ptrUp(x, y), cFar);
check('drag extends selection to include later words',
    selAfterDrag.includes('SELECTTWO'), JSON.stringify(selAfterDrag));

// ---- 3. Tap elsewhere dismisses the selection -------------------------------
const cTap = await page.evaluate(() => window.__cell(2, 6));   // empty row
await page.evaluate(({ x, y }) => window.__ptrDown(x, y), cTap);
await page.evaluate(({ x, y }) => window.__ptrUp(x, y), cTap);
await page.waitForTimeout(50);
check('tap dismisses the bar', await barHidden() && !(await barVisible()));
check('tap clears the selection', (await selection()).length === 0);

// ---- 4. Pinch (spread) changes font size in reflow mode ---------------------
const fontBefore = await page.evaluate(() => window.__ptn.getActiveTerminal().options.fontSize);
const mid = await page.evaluate(() => window.__cell(10, 8));
await page.evaluate((m) => window.__touch('touchstart', [{ x: m.x - 30, y: m.y }, { x: m.x + 30, y: m.y }]), mid);
for (const gap of [60, 100, 150, 200]) {
    await page.evaluate(({ m, g }) => window.__touch('touchmove', [{ x: m.x - g, y: m.y }, { x: m.x + g, y: m.y }]), { m: mid, g: gap });
}
await page.evaluate(() => window.__touch('touchend', []));
await page.waitForTimeout(120);
const fontAfter = await page.evaluate(() => window.__ptn.getActiveTerminal().options.fontSize);
check('pinch/spread increases font size (reflow)', fontAfter > fontBefore, `before=${fontBefore} after=${fontAfter}`);

// ---- 5. Double-tap is a safe no-op in reflow (no crash, no selection) --------
const cDt = await page.evaluate(() => window.__cell(3, 0));
await page.evaluate(({ x, y }) => window.__doubleTap(x, y), cDt);
await page.waitForTimeout(120);
check('double-tap is a no-op in reflow (no selection, bar hidden)',
    await barHidden() && (await selection()).length === 0);

// ---- 6. Fixed-grid mode (zellij): double-tap zoom + two-finger pan ----------
await page.evaluate(() => window.__ptn.enterFixedGrid(80, 24));
await page.waitForTimeout(150);
const fixedInit = await page.evaluate(() => window.__ptn.getFixedState());
check('enters fixed-grid mode (zellij canvas)', fixedInit !== null && Math.abs(fixedInit.zoom - 1) < 0.01,
    JSON.stringify(fixedInit));

// Double-tap at a point -> zoom to 2x.
const cz = await page.evaluate(() => window.__cell(40, 12));
await page.evaluate(({ x, y }) => window.__doubleTap(x, y), cz);
await page.waitForTimeout(120);
const zoomedIn = await page.evaluate(() => window.__ptn.getFixedState());
check('double-tap zooms in to ~2x', zoomedIn && Math.abs(zoomedIn.zoom - 2) < 0.01, JSON.stringify(zoomedIn));

// Two-finger drag -> pan the zoomed canvas (distance held constant so it is not a pinch).
const panBefore = zoomedIn;
const pm = await page.evaluate(() => window.__cell(40, 12));
await page.evaluate((m) => window.__touch('touchstart', [{ x: m.x - 30, y: m.y }, { x: m.x + 30, y: m.y }]), pm);
for (const dxp of [15, 30, 45, 60]) {
    await page.evaluate(({ m, d }) => window.__touch('touchmove',
        [{ x: m.x - 30 + d, y: m.y }, { x: m.x + 30 + d, y: m.y }]), { m: pm, d: dxp });
}
await page.evaluate(() => window.__touch('touchend', []));
await page.waitForTimeout(80);
const panAfter = await page.evaluate(() => window.__ptn.getFixedState());
check('two-finger drag pans the zoomed canvas',
    panAfter && Math.abs(panAfter.panX - panBefore.panX) > 1,
    `panX ${panBefore.panX.toFixed(1)} -> ${panAfter.panX.toFixed(1)}`);

// Double-tap again -> back to fit (1x).
const cz2 = await page.evaluate(() => window.__cell(40, 12));
await page.evaluate(({ x, y }) => window.__doubleTap(x, y), cz2);
await page.waitForTimeout(120);
const zoomedOut = await page.evaluate(() => window.__ptn.getFixedState());
check('double-tap again resets to fit (1x)', zoomedOut && Math.abs(zoomedOut.zoom - 1) < 0.01, JSON.stringify(zoomedOut));

// ---- 7. Click-through maps a tap to the correct cell (fixed grid) -----------
// Regression for the CSS-scale bug: xterm's mouse math ignored the fixed-grid
// transform, so taps (e.g. on a zellij tab) landed on the wrong cell.
async function decodeTap(col, row) {
    const pt = await page.evaluate(({ c, r }) => {
        const t = window.__ptn.getActiveTerminal();
        const el = t.element, screen = el.querySelector('.xterm-screen');
        if (!screen) return { visible: false };
        const sr = screen.getBoundingClientRect(), er = el.getBoundingClientRect();
        const x = sr.left + (c + 0.5) * sr.width / t.cols, y = sr.top + (r + 0.5) * sr.height / t.rows;
        window.__reports = [];
        return { x, y, visible: x >= er.left && x <= er.right && y >= er.top && y <= er.bottom };
    }, { c: col, r: row });
    if (!pt.visible) return null;
    await page.evaluate(({ x, y }) => { const el = window.__ptn.getActiveTerminal().element;
        el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true }));
        el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true })); }, pt);
    await page.waitForTimeout(110);
    const rep = await page.evaluate(() => window.__reports);
    const m = rep.map(r => r.match(/\x1b\[<\d+;(\d+);(\d+)[Mm]/)).find(Boolean);
    return m ? [parseInt(m[1], 10) - 1, parseInt(m[2], 10) - 1] : null;
}
let cellOk = true; const cellDetail = [];
try {
    await page.evaluate(() => {
        const t = window.__ptn.getActiveTerminal();
        window.__reports = [];
        t.onData((d) => { if (d.includes('\x1b[<')) window.__reports.push(d); });
        t.write('\x1b[?1000h\x1b[?1006h'); // enable VT200 + SGR mouse reporting
    });
    await page.waitForTimeout(80);
    for (const [c, r] of [[3, 0], [10, 0], [20, 0], [5, 5]]) {
        const got = await decodeTap(c, r);
        if (got === null) continue;
        if (got[0] !== c || got[1] !== r) cellOk = false;
        cellDetail.push(`(${c},${r})->(${got.join(',')})`);
    }
} catch (e) {
    cellOk = false;
    cellDetail.push('threw: ' + (e && e.message ? e.message : String(e)));
}
check('tap click-through maps to the correct cell (fixed grid)', cellOk, cellDetail.join(' ') || '(no visible cells)');

// ---- console error gate -----------------------------------------------------
check('no console/page errors during run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

console.log('\n================ SUMMARY ================');
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (consoleErrors.length) console.log('\nConsole errors:\n' + consoleErrors.join('\n'));
await browser.close();
process.exit(failed.length ? 1 : 0);
