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
    r = await post('/api/settings', { cap: 5, barangays: BRGYS });
    assert.equal(r.status, 403);
    r = await post('/api/settings', { cap: 5, barangays: BRGYS }, true);
    assert.equal(r.status, 200); ok('host sets 6 barangays and 5 per house (non-host refused)');

    // Host unlock
    await host.goto(BASE + '/?host');
    await host.fill('#pk', 'wrong-pass');
    await host.click('[data-act=unlock]');
    await host.getByText('That passcode did not work.').waitFor(); ok('wrong passcode rejected');
    await host.fill('#pk', KEY);
    await host.click('[data-act=unlock]');
    await host.getByRole('heading', { name: 'From Ideas to Impact' }).waitFor();
    await host.locator('#qrHome svg').waitFor(); ok('host unlocked, Home shows QR');
    await host.click('#qrHome');
    await host.locator('.qrbig svg').waitFor();
    const big = await host.locator('.qrbig svg').evaluate((e) => e.getBoundingClientRect().width);
    assert.ok(big > 500, 'enlarged QR is big: ' + big);
    await host.click('.qrbig');
    await host.locator('.qrbig').waitFor({ state: 'detached' }); ok('clicking the QR enlarges it; clicking again returns it to size');

    // Phone joins
    await phone.goto(BASE + '/');
    await phone.fill('#jname', 'Ana');
    await phone.click('[data-act=brgy][data-b="2"]');
    await phone.click('[data-act=joingo]');
    await phone.getByText('You are registered.').waitFor({ timeout: 8000 }); ok('phone registered as Ana from Brgy 3, waiting for a house');
    await host.locator('#jn', { hasText: '1 joined' }).waitFor({ timeout: 8000 });
    await host.locator('#regn', { hasText: /^1$/ }).waitFor({ timeout: 8000 }); ok('host sees 1 joined; big registered counter shows 1');
    r = await post('/api/assign', {}, true); assert.equal(r.status, 409, 'no assigning while registration is open');
    await phone.waitForTimeout(1500); assert.ok(await phone.getByText('You are registered.').isVisible(), 'still waiting while open');
    await host.locator('#hstat .chip', { hasText: 'Closing will assign: 1 person → 1 houses' }).waitFor({ timeout: 8000 });
    await host.locator('[data-act=regtoggle]', { hasText: 'Close registration and assign houses' }).click();
    await phone.locator('.myhouse b', { hasText: 'House Stark' }).waitFor({ timeout: 8000 }); ok('no house while registration is open; closing registration assigns House Stark');

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
    const segOpts = await host.locator('#bseg option').evaluateAll((os) => os.map((o) => o.value));
    assert.deepEqual(segOpts, ['open', 'p1', 'p2', 'p3'], 'only segments presented so far: ' + segOpts);
    assert.equal(await host.locator('.bq', { hasText: 'Who should be the owner of a risk?' }).count(), 1, 'Know the words was already presented');
    await host.selectOption('#bseg', 'p1');
    await host.locator('.bq', { hasText: 'Hold a basketball league' }).waitFor();
    // Back on the first Part 3 slide, questions from later Part 3 slides are hidden
    await host.click('[data-act=home]'); await host.click('[data-act=open][data-s="3"]'); await openPanel();
    await host.evaluate(() => { const d = document.querySelector('#askd'); if (d) d.open = true; });
    await host.locator('#bankw .bq', { hasText: 'Additional Controls lower which number?' }).waitFor();
    assert.equal(await host.locator('#bankw .bq', { hasText: 'What is the Impact?' }).count(), 0, 'Impact questions hidden before the Impact slide');
    assert.equal(await host.locator('#bankw .bq', { hasText: 'What is the treatment?' }).count(), 0, 'treatment questions hidden before the treatment slide');
    ok('question bank shows only what has been presented so far');

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

    // Clear all (two taps): wipes people and houses, keeps house size and barangays; phones go back to the join screen
    await host.click('[data-act=home]');
    await host.locator('#hstat', { hasText: 'houses in use' }).waitFor({ timeout: 8000 });
    await host.click('[data-act=clear]');
    await host.click('[data-act=clear]');
    await host.locator('#jn', { hasText: '0 joined' }).waitFor({ timeout: 8000 });
    r = await fetch(BASE + '/api/teams'); const after = await r.json();
    assert.equal(after.cap, 5); assert.equal(after.houses, 0); assert.equal(after.reg, 'open'); assert.deepEqual(after.barangays, BRGYS); assert.deepEqual(after.counts, {});
    await phone.locator('#jname').waitFor({ timeout: 10000 }); ok('clear all wipes people and houses, keeps settings, phones re-join');

    // Everyone registers first; then Assign opens just enough houses and mixes barangays
    r = await post('/api/settings', { cap: 3 }, true); assert.equal(r.status, 200);
    for (let i = 0; i < 12; i++) {
      r = await post('/api/me', { cid: 'mix' + i, doc: { name: 'M' + i, barangay: BRGYS[i % 6], answers: {} } });
      assert.equal(r.status, 200); assert.equal((await r.json()).team, 0, 'no house before Assign');
    }
    r = await post('/api/me', { cid: 'mix99', doc: { name: 'Nobody', barangay: 'Not a barangay', answers: {} } }); assert.equal(r.status, 400);
    await host.locator('#hstat', { hasText: '12 registered' }).waitFor({ timeout: 25000 });
    await host.locator('#hstat .chip', { hasText: 'Closing will assign: 12 people → 4 houses of up to 3' }).waitFor({ timeout: 25000 });
    await host.click('[data-act=regtoggle]');
    await host.locator('#hstat', { hasText: '4 houses in use' }).waitFor({ timeout: 8000 });
    const docs = async () => { const x = await fetch(BASE + '/api/responses', { headers: { 'x-key': KEY } }); return (await x.json()).map((d) => d.data); };
    let all = await docs(); const byH = {};
    for (const d of all) (byH[d.team] = byH[d.team] || []).push(d.barangay);
    assert.deepEqual(Object.keys(byH).sort(), ['1', '2', '3', '4']);
    for (const h in byH) { assert.equal(byH[h].length, 3, 'house ' + h + ' size'); assert.equal(new Set(byH[h]).size, 3, 'house ' + h + ' mixes barangays: ' + byH[h]); }
    const m0 = all.find((d) => d.name === 'M0').team;
    r = await post('/api/me', { cid: 'mix0', doc: { name: 'M0', barangay: BRGYS[0], team: 9, answers: {} } });
    assert.equal((await r.json()).team, m0); ok('12 registered → 4 houses of 3, each mixing barangays; a phone cannot change its house');

    // Registration is now closed: new people are refused and phones say so
    await host.locator('#hstat .chip', { hasText: 'Registration closed' }).waitFor();
    r = await post('/api/me', { cid: 'late1', doc: { name: 'Late', barangay: BRGYS[1], answers: {} } }); assert.equal(r.status, 423);
    await phone.getByText('Registration is closed.').waitFor({ timeout: 15000 }); ok('closed registration: new people refused (423); phone shows it');

    // Reopen: a latecomer registers and waits; closing again places them (all 4 houses full → House 5, Greyjoy); nobody else moves
    await host.click('[data-act=regtoggle]');
    await host.locator('#hstat .chip', { hasText: 'Registration open' }).waitFor(); await host.waitForTimeout(400);
    await phone.locator('#jname').waitFor({ timeout: 15000 });
    await phone.fill('#jname', 'Ben');
    await phone.click('[data-act=brgy][data-b="0"]');
    await phone.click('[data-act=joingo]');
    await phone.getByText('You are registered.').waitFor({ timeout: 8000 });
    await host.locator('#hstat .chip', { hasText: 'Closing will assign: 1 person to houses with room' }).waitFor({ timeout: 25000 });
    await host.click('[data-act=regtoggle]');
    await phone.locator('.myhouse b', { hasText: 'House Greyjoy' }).waitFor({ timeout: 8000 });
    all = await docs(); assert.equal(all.find((d) => d.name === 'M0').team, m0);
    assert.equal(all.filter((d) => d.team >= 1 && d.team <= 4).length, 12); ok('reopened: latecomer placed in a new house; existing members keep their houses');

    // Same barangay per house: 10 from one barangay → 2 houses of 5; 4 from another → 1 house; latecomers stay with their barangay
    r = await post('/api/clear', {}, true); assert.equal(r.status, 200);
    r = await post('/api/settings', { cap: 5, mode: 'same' }, true); assert.equal(r.status, 200);
    for (let i = 0; i < 14; i++) { r = await post('/api/me', { cid: 'same' + i, doc: { name: 'S' + i, barangay: i < 10 ? BRGYS[0] : BRGYS[1], answers: {} } }); assert.equal(r.status, 200); }
    r = await post('/api/settings', { reg: 'closed' }, true); assert.equal(r.status, 200); assert.equal((await r.json()).assigned.houses, 3);
    all = await docs(); const hs = {};
    for (const d of all) (hs[d.team] = hs[d.team] || []).push(d.barangay);
    assert.deepEqual(Object.values(hs).map((b) => b.length).sort(), [4, 5, 5]);
    for (const h in hs) assert.equal(new Set(hs[h]).size, 1, 'house ' + h + ' is one barangay');
    r = await post('/api/settings', { reg: 'open' }, true); assert.equal(r.status, 200);
    r = await post('/api/me', { cid: 'same20', doc: { name: 'LateB', barangay: BRGYS[1], answers: {} } }); assert.equal((await r.json()).team, 0);
    r = await post('/api/me', { cid: 'same21', doc: { name: 'LateC', barangay: BRGYS[2], answers: {} } }); assert.equal((await r.json()).team, 0);
    r = await post('/api/settings', { reg: 'closed' }, true); assert.equal((await r.json()).assigned.placed, 2);
    all = await docs(); const tB = all.find((d) => d.name === 'LateB').team, tC = all.find((d) => d.name === 'LateC').team;
    assert.equal(hs[tB][0], BRGYS[1], 'latecomer joins a house of their barangay'); assert.equal(tC, 4, 'new barangay opens a new house');
    ok('same-barangay houses: 10 → 2 houses of 5, 4 → 1 house; latecomers stay with their barangay');

    // Restore and clean up
    r = await post('/api/settings', { cap: 5, mode: 'mix' }, true); assert.equal(r.status, 200);
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
