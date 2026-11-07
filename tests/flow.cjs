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

  const openPanel = async () => { if (await host.locator('.ptab').isVisible()) { await host.click('.ptab'); await host.locator('#panel').waitFor(); } };
  try {
    // API guards
    let r = await fetch(BASE + '/api/live', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"prompt":null}' });
    assert.equal(r.status, 403); ok('non-host POST /api/live → 403');
    r = await fetch(BASE + '/api/responses');
    assert.equal(r.status, 403); ok('non-host GET /api/responses → 403');
    r = await fetch(BASE + '/api/me', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cid: 'abcd1234', doc: { name: 'X', barangay: 'Brgy 1', answers: { 'risk@x': { v: { text: 'a', occ: '<img src=x onerror=alert(1)>', imp: 2 }, t: 1 } } } }) });
    assert.equal(r.status, 400); ok('malformed risk answer rejected → 400');
    r = await fetch(BASE + '/api/clear', { method: 'POST', headers: { 'x-key': KEY } });
    assert.equal(r.status, 200); ok('host clear all');
    const post = (path, body, key) => fetch(BASE + path, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, key ? { 'x-key': KEY } : {}), body: JSON.stringify(body) });
    const BRGYS = ['Brgy 1', 'Brgy 2', 'Brgy 3', 'Brgy 4', 'Brgy 5', 'Brgy 6'];
    r = await post('/api/settings', { houses: 9, cap: 5, barangays: BRGYS });
    assert.equal(r.status, 403);
    r = await post('/api/settings', { houses: 9, cap: 5, barangays: BRGYS }, true);
    assert.equal(r.status, 200); ok('host sets 6 barangays, 9 houses, 5 per house (non-host refused)');

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
    await phone.click('[data-act=brgy][data-b="2"]');
    await phone.click('[data-act=joingo]');
    await phone.getByText('You are in.').waitFor();
    await phone.locator('.myhouse b', { hasText: /^House / }).waitFor({ timeout: 8000 }); ok('phone joined as Ana from Brgy 3 and was placed in a house');
    await host.locator('#jn', { hasText: '1 joined' }).waitFor({ timeout: 8000 }); ok('host sees 1 joined');

    // First slide has QR
    await host.click('[data-act=open][data-s="0"]');
    await host.locator('#qrSlide svg').waitFor(); ok('first slide shows QR');

    // Text question: draft survives re-renders (polls, presenter changes)
    await host.click('[data-act=next]');
    await openPanel(); await host.click('[data-act=push]');
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

    // Choice quiz in Part 1 (measurable objective): push, answer, reveal, reload
    await host.click('[data-act=home]');
    await host.click('[data-act=open][data-s="1"]');
    for (let i = 0; i < 3; i++) await host.click('[data-act=next]');
    await host.getByRole('heading', { name: 'Which one is measurable?' }).waitFor();
    await openPanel(); await host.click('[data-act=push]');
    await phone.locator('[data-act=pick][data-n="1"]').waitFor({ timeout: 8000 }); ok('choice question pushed to phone');
    await phone.click('[data-act=pick][data-n="1"]');
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
    await openPanel(); await host.click('[data-act=push]');
    await phone.locator('textarea#din').waitFor({ timeout: 8000 });
    await phone.fill('#din', 'Rain on the day');
    await phone.click('[data-act=occ][data-n="4"]');
    assert.equal(await phone.inputValue('#din'), 'Rain on the day');
    await phone.click('[data-act=imp][data-n="2"]');
    await phone.click('[data-act=send]');
    await phone.getByText('Sent ✓').waitFor();
    await host.locator('#plive', { hasText: '1 of 1 answered' }).waitFor({ timeout: 8000 }); ok('risk answer (4 + 2 = 6, Medium) reached host');

    // Question bank: one tap pushes a ready question (Part 3: Occurrence 3 + Impact 4 = 7)
    await openPanel(); await host.click('#askd summary');
    await host.locator('.bq', { hasText: 'Occurrence 3 + Impact 4' }).locator('[data-act=bankgo]').click();
    await phone.getByText('Occurrence 3 + Impact 4. What is the Risk Rating?').waitFor({ timeout: 8000 });
    await phone.fill('#din', '7');
    await phone.click('[data-act=send]');
    await host.locator('#plive', { hasText: '1 of 1 answered' }).waitFor({ timeout: 8000 });
    ok('question bank push answered on phone');
    await host.locator('.bq', { hasText: 'Occurrence 3 + Impact 4' }).waitFor({ state: 'detached' });
    await host.click('[data-act=bankused]');
    await host.locator('.bq.done', { hasText: 'Occurrence 3 + Impact 4' }).waitFor(); ok('pushed question leaves the bank list (Show pushed brings it back)');
    await host.selectOption('#bseg', 'close');
    await host.locator('.bq', { hasText: 'One thing you learned today.' }).waitFor(); ok('question bank switches segment');

    // Questions panel collapses sideways and comes back; the slide gets wider
    const w0 = await host.locator('#slide').evaluate((e) => e.getBoundingClientRect().width);
    await host.click('#pbtn');
    await host.locator('#panel').waitFor({ state: 'hidden' });
    await host.locator('.ptab').waitFor();
    await host.waitForTimeout(400);
    const w1 = await host.locator('#slide').evaluate((e) => e.getBoundingClientRect().width);
    assert.ok(w1 > w0 + 200, `slide did not widen: ${w0} → ${w1}`);
    await host.screenshot({ path: SHOTS + '/host-panel-hidden.png' });
    await host.click('.ptab');
    await host.locator('#panel').waitFor(); ok('questions panel hides sideways and reopens from the edge tab');
    await host.click('[data-act=prev]');
    await host.locator('#panel').waitFor({ state: 'hidden' }); await host.locator('.ptab').waitFor();
    await host.click('.ptab'); await host.keyboard.press('ArrowRight');
    await host.locator('#panel').waitFor({ state: 'hidden' }); ok('Back, Next and arrow keys slide the panel away');
    await openPanel();

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

    // Clear all (two taps): wipes people, keeps the settings; phones go back to the join screen
    await host.click('[data-act=home]');
    await host.locator('#hsv', { hasText: /^9$/ }).waitFor({ timeout: 8000 });
    await host.click('[data-act=clear]');
    await host.click('[data-act=clear]');
    await host.locator('#jn', { hasText: '0 joined' }).waitFor({ timeout: 8000 });
    r = await fetch(BASE + '/api/teams'); const after = await r.json();
    assert.equal(after.cap, 5); assert.equal(after.houses, 9); assert.deepEqual(after.barangays, BRGYS); assert.deepEqual(after.counts, {});
    await phone.locator('#jname').waitFor({ timeout: 10000 }); ok('clear all wipes people, keeps settings, phones re-join');

    // Random assignment mixes barangays: 2 houses x 3 people, 6 people from 3 barangays
    r = await post('/api/settings', { houses: 2, cap: 3 }, true); assert.equal(r.status, 200);
    const placed = [];
    for (let i = 0; i < 6; i++) {
      r = await post('/api/me', { cid: 'mix' + i, doc: { name: 'M' + i, barangay: BRGYS[i % 3], answers: {} } });
      assert.equal(r.status, 200); const j = await r.json(); assert.ok(j.team === 1 || j.team === 2, 'team ' + j.team); placed.push([BRGYS[i % 3], j.team]);
    }
    for (const h of [1, 2]) { const bs = placed.filter((x) => x[1] === h).map((x) => x[0]); assert.equal(bs.length, 3); assert.equal(new Set(bs).size, 3, 'house ' + h + ' mixes barangays: ' + bs); }
    r = await post('/api/me', { cid: 'mix0', doc: { name: 'M0 renamed', barangay: BRGYS[0], team: 2, answers: {} } });
    const keep = (await r.json()).team; assert.equal(keep, placed[0][1], 'house cannot be changed from a phone'); ok('each house gets one person per barangay; house cannot be changed from a phone');
    r = await post('/api/me', { cid: 'mix9', doc: { name: 'Seven', barangay: BRGYS[0], answers: {} } });
    assert.equal(r.status, 409);
    r = await post('/api/me', { cid: 'mix8', doc: { name: 'Nobody', barangay: 'Not a barangay', answers: {} } });
    assert.equal(r.status, 400); ok('when every house is full the next person is refused (409); unknown barangay refused');

    // Phone sees "all houses full", host adds a house on Home, phone joins House 3 (Targaryen)
    await phone.fill('#jname', 'Ben');
    await phone.click('[data-act=brgy][data-b="0"]');
    await phone.click('[data-act=joingo]');
    await phone.getByText('All houses are full').waitFor({ timeout: 8000 });
    await host.locator('#hsv', { hasText: /^2$/ }).waitFor({ timeout: 25000 });
    await host.click('[data-act=hsup]');
    await host.locator('#hsv', { hasText: /^3$/ }).waitFor(); await host.waitForTimeout(500);
    await phone.click('[data-act=joingo]');
    await phone.locator('.myhouse b', { hasText: 'House Targaryen' }).waitFor({ timeout: 8000 }); ok('phone told all houses are full; host adds a house; phone placed in it');

    // Restore and clean up
    r = await post('/api/settings', { houses: 9, cap: 5 }, true); assert.equal(r.status, 200);
    r = await post('/api/clear', {}, true); assert.equal(r.status, 200);

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
