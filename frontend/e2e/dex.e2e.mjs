// Samsung DeX checks: input is mouse + physical keyboard on a desktop-sized
// display (pointerType 'mouse'), so the gesture layer falls back to xterm's
// native mouse handling. Covers the DeX-specific fixes (docs/design/gestures.md):
//   - mouse selection surfaces the Copy bar (wiring)
//   - a mouse click maps to the correct cell in fixed-grid mode
//   - Ctrl/Cmd + wheel zooms the fixed grid; middle-button drag pans it
//
// NOTE: real mouse-drag -> xterm selection is xterm's built-in behavior (works
// on hardware) and is not asserted here — Playwright's synthetic mouse does not
// reliably drive xterm's SelectionService. The select->bar wiring IS asserted.
import { chromium } from 'playwright';

const URL = process.env.PTN_URL || 'http://127.0.0.1:9455/?e2e=1';
const results = [];
const check = (n, p, d = '') => { results.push({ n, p }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false, deviceScaleFactor: 1 });
const page = await context.newPage();
const errs = [];
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', e => errs.push('pageerror: ' + e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ptn?.getActiveTerminal?.(), { timeout: 15000 }).catch(() => {});

const booted = await page.evaluate(() => Boolean(window.__ptn?.getActiveTerminal?.()));
check('app boots + terminal ready', booted);
if (!booted) { await browser.close(); process.exit(1); }

// keyboard works via a mouse click to focus, then typing.
await page.mouse.click(640, 400);
await page.waitForTimeout(80);
check('mouse click focuses the terminal', await page.evaluate(() => document.activeElement === window.__ptn.getActiveTerminal().textarea));
await page.keyboard.type('echo DEXOK');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
check('physical keyboard reaches the shell', await page.evaluate(() => {
    const b = window.__ptn.getActiveTerminal().buffer.active; let s = '';
    for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) s += l.translateToString(true); }
    return (s.match(/DEXOK/g) || []).length >= 2;
}));

const barVisible = () => page.evaluate(() => window.__ptn.selectionBarVisible() && !document.getElementById('selection-bar').classList.contains('hidden'));
const fixed = () => page.evaluate(() => window.__ptn.getFixedState());

// ---- Copy bar surfaces on selection (mouse has no long-press) ----
await page.evaluate(() => window.__ptn.getActiveTerminal().select(0, 0, 12));
await page.waitForTimeout(120);
check('selection surfaces the Copy bar', await barVisible());
await page.evaluate(() => window.__ptn.getActiveTerminal().clearSelection());
await page.waitForTimeout(120);
check('clearing selection hides the bar', !(await barVisible()));

// ---- Fixed grid: click mapping, then Ctrl+wheel zoom, then middle-drag pan ----
await page.evaluate(() => window.__ptn.enterFixedGrid(80, 24));
await page.waitForTimeout(180);
await page.evaluate(() => { const t = window.__ptn.getActiveTerminal(); window.__reports = []; t.onData(d => { if (d.includes('\x1b[<')) window.__reports.push(d); }); t.write('\x1b[?1000h\x1b[?1006h'); });
await page.waitForTimeout(80);
let clickOk = true; const detail = [];
for (const [c, r] of [[10, 0], [20, 0], [30, 0]]) {
    const pt = await page.evaluate(({ c, r }) => { const t = window.__ptn.getActiveTerminal(); const sr = t.element.querySelector('.xterm-screen').getBoundingClientRect(); window.__reports = []; return { x: sr.left + (c + 0.5) * sr.width / t.cols, y: sr.top + (r + 0.5) * sr.height / t.rows }; }, { c, r });
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(90);
    const rep = await page.evaluate(() => window.__reports);
    const m = rep.map(s => s.match(/\x1b\[<\d+;(\d+);(\d+)[Mm]/)).find(Boolean);
    const got = m ? [parseInt(m[1], 10) - 1, parseInt(m[2], 10) - 1] : null;
    if (!got || got[0] !== c || got[1] !== r) clickOk = false;
    detail.push(`(${c},${r})->${got ? got.join(',') : 'NONE'}`);
}
check('mouse click maps to the correct cell (fixed grid)', clickOk, detail.join(' '));

const center = await page.evaluate(() => { const r = window.__ptn.getActiveTerminal().element.getBoundingClientRect(); return { x: r.left + r.width * 0.4, y: r.top + r.height * 0.4 }; });
const wheel = (dy) => page.evaluate(({ x, y, dy }) => window.__ptn.getActiveTerminal().element.dispatchEvent(
    new WheelEvent('wheel', { deltaY: dy, ctrlKey: true, clientX: x, clientY: y, bubbles: true, cancelable: true })), { ...center, dy });
const z0 = (await fixed()).zoom;
for (let i = 0; i < 4; i++) { await wheel(-120); await page.waitForTimeout(30); }
await page.waitForTimeout(250);
const z1 = (await fixed()).zoom;
check('Ctrl+wheel zooms the fixed grid in', z1 > z0 + 0.1, `zoom ${z0} -> ${z1}`);
for (let i = 0; i < 6; i++) { await wheel(120); await page.waitForTimeout(30); }
await page.waitForTimeout(250);
check('Ctrl+wheel zooms back out', (await fixed()).zoom < z1, `-> ${(await fixed()).zoom}`);

for (let i = 0; i < 4; i++) { await wheel(-120); await page.waitForTimeout(30); }
await page.waitForTimeout(250);
const panBefore = (await fixed()).panX;
await page.mouse.move(center.x, center.y);
await page.mouse.down({ button: 'middle' });
await page.mouse.move(center.x + 80, center.y + 20, { steps: 6 });
await page.mouse.up({ button: 'middle' });
await page.waitForTimeout(120);
check('middle-button drag pans the zoomed grid', Math.abs((await fixed()).panX - panBefore) > 1, `panX ${panBefore.toFixed(1)} -> ${(await fixed()).panX.toFixed(1)}`);

check('no console/page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
const failed = results.filter(r => !r.p).length;
console.log(`\n================ ${results.length - failed}/${results.length} DeX checks passed ================`);
await browser.close();
process.exit(failed ? 1 : 0);
