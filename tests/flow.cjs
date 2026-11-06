// End-to-end check of the live flow: host + phone.
// Usage:  node tests/flow.cjs                       (local: wrangler dev on :8787, key test123)
//         BASE_URL=https://ideas-to-impact.YOU.workers.dev KEY=yourpass node tests/flow.cjs
// WARNING: this clears all answers on the target before it starts.
const { chromium, devices } = require('playwright');
const assert = require('assert/strict');
const fs = require('fs');

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const KEY = process.env.KEY || 'test123';
const SHOTS = __dirname + '/shots';
let step = 0;
const ok = (m) => console.log(`  ✓ ${++step}. ${m}`);

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  // Behind a corporate/sandbox proxy, set HTTPS_PROXY (and NODE_USE_ENV_PROXY=1 for Node's own fetch).
  const proxy = !BASE.includes('127.0.0.1') && process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
  const browser = await chromium.launch(proxy ? { proxy } : {});
  const extra = proxy ? { ignoreHTTPSErrors: true } : {};
  const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...extra });
  const phoneCtx = await browser.newContext({ ...devices['Pixel 5'], ...extra });
  const host = await hostCtx.newPage();
  const phone = await phoneCtx.newPage();
  const errors = [];
  for (const [n, p] of [['host', host], ['phone', phone]]) p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`));

  try {
    // API guards
    let r = await fetch(BASE + '/api/live', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"prompt":null}' });
    assert.equal(r.status, 403); ok('non-host POST /api/live → 403');
    r = await fetch(BASE + '/api/responses');
    assert.equal(r.status, 403); ok('non-host GET /api/responses → 403');
    r = await fetch(BASE + '/api/me', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cid: 'abcd1234', doc: { name: 'X', team: 1, answers: { 'risk@x': { v: { text: 'a', occ: '<img src=x onerror=alert(1)>', imp: 2 }, t: 1 } } } }) });
    assert.equal(r.status, 400); ok('malformed risk answer rejected → 400');
    r = await fetch(BASE + '/api/clear', { method: 'POST', headers: { 'x-key': KEY } });
    assert.equal(r.status, 200); ok('host clear all');

    // Host unlock
    await host.goto(BASE + '/?host');
    await host.fill('#pk', 'wrong-pass');
    await host.click('[data-act=unlock]');
    await host.getByText('That passcode did not work.').waitFor(); ok('wrong passcode rejected');
    await host.fill('#pk', KEY);
    await host.click('[data-act=unlock]');
    await host.getByRole('heading', { name: 'From Ideas to Impact' }).waitFor();
    await host.locator('#qrHome svg').waitFor(); ok('host unlocked, Home shows QR');

    // Phone joins
    await phone.goto(BASE + '/');
    await phone.fill('#jname', 'Ana');
    await phone.click('[data-act=team][data-t="3"]');
    await phone.click('[data-act=joingo]');
    await phone.getByText('You are in.').waitFor(); await phone.getByText('House Targaryen').waitFor(); ok('phone joined as Ana, House Targaryen');
    await host.locator('#jn', { hasText: '1 joined' }).waitFor({ timeout: 8000 }); ok('host sees 1 joined');

    // First slide has QR
    await host.click('[data-act=open][data-s="0"]');
    await host.locator('#qrSlide svg').waitFor(); ok('first slide shows QR');

    // Text question: draft survives re-renders (polls, presenter changes)
    await host.click('[data-act=next]');
    await host.click('[data-act=push]');
    await phone.locator('#din').waitFor({ timeout: 8000 });
    await phone.fill('#din', 'The sound system died');
    await host.click('[data-act=toggleopen]'); // close → phone re-renders
    await phone.getByText('This question is closed.').waitFor({ timeout: 8000 });
    await host.click('[data-act=toggleopen]'); // reopen
    await phone.locator('#din').waitFor({ timeout: 8000 });
    assert.equal(await phone.inputValue('#din'), 'The sound system died'); ok('typed draft kept across close/reopen re-render');
    await phone.click('[data-act=send]');
    await phone.getByText('Sent ✓').waitFor();
    await host.locator('#plive', { hasText: '1 of 1 answered' }).waitFor({ timeout: 8000 }); ok('text answer reached host');

    // Number question in Part 2
    await host.click('[data-act=home]');
    await host.click('[data-act=open][data-s="2"]');
    for (let i = 0; i < 3; i++) await host.click('[data-act=next]');
    await host.getByRole('heading', { name: 'Your turn' }).waitFor();
    await host.click('[data-act=push]');
    await phone.locator('input#din[type=number]').waitFor({ timeout: 8000 }); ok('number question pushed to phone');
    await phone.fill('#din', '20');
    await phone.click('[data-act=send]');
    await phone.getByText('Sent ✓').waitFor();
    await host.locator('#plive', { hasText: '1 of 1 answered' }).waitFor({ timeout: 8000 }); ok('host sees 1 of 1 answered');
    await host.click('[data-act=reveal]');
    await phone.getByText('You got it.').waitFor({ timeout: 8000 }); ok('result revealed on phone');
    await phone.reload();
    await phone.getByText('Sent ✓').waitFor({ timeout: 8000 });
    await phone.getByText('You got it.').waitFor(); ok('phone reload keeps answer');

    // Risk question
    await host.click('[data-act=home]');
    await host.click('[data-act=open][data-s="3"]');
    for (let i = 0; i < 12; i++) {
      if (await host.getByRole('heading', { name: "Your team's biggest risk" }).count()) break;
      await host.click('[data-act=next]');
    }
    await host.click('[data-act=push]');
    await phone.locator('textarea#din').waitFor({ timeout: 8000 });
    await phone.fill('#din', 'Rain on the day');
    await phone.click('[data-act=occ][data-n="4"]');
    assert.equal(await phone.inputValue('#din'), 'Rain on the day');
    await phone.click('[data-act=imp][data-n="2"]');
    await phone.click('[data-act=send]');
    await phone.getByText('Sent ✓').waitFor();
    await host.locator('#plive', { hasText: '1 of 1 answered' }).waitFor({ timeout: 8000 }); ok('risk answer (4 × 2) reached host');

    // Question bank: one tap pushes a ready question (Part 3: Occurrence 3 × Impact 4)
    await host.click('#askd summary');
    await host.locator('.bq', { hasText: 'Occurrence 3 × Impact 4' }).locator('[data-act=bankgo]').click();
    await phone.getByText('Occurrence 3 × Impact 4. What is the Risk Rating?').waitFor({ timeout: 8000 });
    await phone.fill('#din', '12');
    await phone.click('[data-act=send]');
    await host.locator('#plive', { hasText: '1 of 1 answered' }).waitFor({ timeout: 8000 });
    ok('question bank push answered on phone');
    await host.locator('.bq', { hasText: 'Occurrence 3 × Impact 4' }).waitFor({ state: 'detached' });
    await host.click('[data-act=bankused]');
    await host.locator('.bq.done', { hasText: 'Occurrence 3 × Impact 4' }).waitFor(); ok('pushed question leaves the bank list (Show pushed brings it back)');
    await host.selectOption('#bseg', 'close');
    await host.locator('.bq', { hasText: 'One thing you learned today.' }).waitFor(); ok('question bank switches segment');

    // Projector fit at 1280x720: no horizontal scroll, nav buttons visible
    const fit = await host.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.ok(fit.sw <= fit.cw, `horizontal scroll at 1280: ${fit.sw} > ${fit.cw}`);
    assert.ok(await host.locator('[data-act=next]').isVisible());
    await host.screenshot({ path: SHOTS + '/host-1280x720.png' });
    await phone.screenshot({ path: SHOTS + '/phone.png' }); ok('1280x720 presenter has no horizontal scroll');

    // Poll failure: block the API, the screen stays up and shows offline, then recovers
    await phoneCtx.setOffline(true);
    await phone.locator('#net', { hasText: 'Reconnecting' }).waitFor({ timeout: 10000 });
    assert.ok(await phone.getByText('Sent ✓').isVisible()); ok('phone shows "Reconnecting" and keeps the screen during outage');
    await phoneCtx.setOffline(false);
    await phone.locator('#net', { hasText: 'Reconnecting' }).waitFor({ state: 'hidden', timeout: 10000 }); ok('phone recovers after outage');

    // House cap: 5 per house, the 6th is refused; the phone shows the house as full
    for (let i = 0; i < 5; i++) {
      r = await fetch(BASE + '/api/me', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cid: 'capx' + i, doc: { name: 'P' + i, team: 2, answers: {} } }) });
      assert.equal(r.status, 200);
    }
    r = await fetch(BASE + '/api/me', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cid: 'capx9', doc: { name: 'Six', team: 2, answers: {} } }) });
    assert.equal(r.status, 409);
    r = await fetch(BASE + '/api/teams'); const tm = await r.json();
    assert.equal(tm.counts['2'], 5); ok('house cap: 6th member of Lannister refused (409)');
    await phone.click('[data-act=editprof]');
    await phone.locator('[data-act=team][data-t="2"][disabled]', { hasText: 'Full' }).waitFor({ timeout: 8000 });
    await phone.locator('[data-act=team][data-t="3"]', { hasText: 'Targaryen' }).waitFor(); ok('phone shows houses by name, full house disabled');
    await phone.click('[data-act=joingo]');

    // Clear all (two taps)
    await host.click('[data-act=home]');
    await host.click('[data-act=clear]');
    await host.click('[data-act=clear]');
    await host.locator('#jn', { hasText: '0 joined' }).waitFor({ timeout: 8000 }); ok('clear all (two taps) wipes answers');

    assert.deepEqual(errors, [], 'page errors: ' + errors.join('; ')); ok('no page errors');
    console.log(`\nAll ${step} checks passed against ${BASE}`);
  } catch (e) {
    await host.screenshot({ path: SHOTS + '/FAIL-host.png' }).catch(() => {});
    await phone.screenshot({ path: SHOTS + '/FAIL-phone.png' }).catch(() => {});
    console.error('\n✗ FAILED after step', step, '\n', e.message, errors.length ? '\nPage errors: ' + errors.join('; ') : '');
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
