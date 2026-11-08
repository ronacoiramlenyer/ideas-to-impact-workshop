// Usage: node tests/offline.cjs   (checks the Plan B file works with the network blocked)
// Plan B check: open the saved file with the network fully blocked.
const { chromium } = require('playwright'); const assert = require('assert/strict');
(async () => { const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 720 }, offline: true }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await ctx.route('**/*', r => r.request().url().startsWith('file:') ? r.continue() : r.abort());
  await p.goto('file://' + require('path').resolve(__dirname, '../handouts/From_Ideas_to_Impact_OFFLINE.html'));
  await p.click('[data-act=offline]'); await p.waitForSelector('.hero');
  assert.ok(await p.locator('.houses').isHidden());
  await p.click('[data-act=open][data-s="0"]'); await p.click('[data-act=next]'); await p.click('[data-act=next]'); const lbl = await p.locator('#qrSlide .qrl').textContent(); assert.equal(lbl, 'ideas-to-impact.learneasytoday.workers.dev');
  await p.click('[data-act=home]'); await p.click('[data-act=open][data-s="3"]'); for (let k=0;k<5;k++) await p.click('[data-act=next]');
  await p.getByRole('heading', { name: 'Risk rating calculator' }).waitFor(); await p.click('[data-k=o][data-n="5"]'); await p.locator('#rLine', { hasText: '5 + 2 = 7' }).waitFor();
  await p.click('[data-act=tgo]'); await p.waitForTimeout(1200); const tm = await p.locator('#tmr').textContent(); assert.notEqual(tm, '40:00');
  await p.click('.ptab'); await p.locator('#plive .chip', { hasText: 'Offline: slides only' }).waitFor();
  await p.screenshot({ path: __dirname + '/shots/offline.png' });
  assert.deepEqual(errs, []); console.log('offline OK: slides, calculator, timers work; QR points to', lbl);
  await b.close(); })().catch(e => { console.error('FAIL', e.message); process.exit(1); });
