# From Ideas to Impact: live session app

Presenter screen + participant phones, no accounts needed. Runs on your own Cloudflare account (free plan is enough).

## Deploy (about 5 minutes)
1. Install Node.js 18 or newer, then in this folder run:  `npm install`
2. Log in to Cloudflare (opens a browser):  `npx wrangler login`
3. Deploy:  `npx wrangler deploy`
   Wrangler prints your address, like `https://ideas-to-impact.YOURNAME.workers.dev`
4. Set your presenter passcode:  `npx wrangler secret put PRESENTER_KEY`  (type a passcode you will remember)
   Until this is set, nobody can open the presenter view.

## Use it
- Presenter: open `ADDRESS/?host` and enter the passcode.
- Participants: scan the QR code on the first slide or the Home page (it points to `ADDRESS`). They type a first name and tap their barangay. That registers them; they wait for a house.
- Houses (Home → "Registration and houses"): let everyone register, then tap **Close registration and assign houses**. Nobody gets a house while registration is open. Closing opens just enough houses (people ÷ members per house, e.g. 60 ÷ 5 = 12) in this order: Stark, Lannister, Targaryen, Baratheon, Greyjoy, Tyrell, Martell, Arryn, Tully, Bolton, Frey, Tarly (then Mormont, Reed, Umber, Karstark, Clegane if needed). **Group houses by**: *Mix barangays* (each house mixes barangays) or *Same barangay* (each house is one barangay; 10 people → 2 houses of 5). For latecomers, tap **Reopen registration**; they register and wait, and closing again places only them (a new house opens if all are full). Nobody already in a house is moved. Members per house, grouping, and the barangay list survive Clear all; houses and registration reset.
- Before the real session: Home > "Clear all answers" (tap twice) to wipe test data. Phones that joined during testing are asked to join again.
- Test once with your own phone before the day.

## Test locally
```
echo PRESENTER_KEY=test123 > .dev.vars
npx wrangler dev
node tests/flow.cjs                     # needs Playwright: npm i -D playwright && npx playwright install chromium
```
To check the deployed site (this clears all answers there):
`BASE_URL=https://ideas-to-impact.YOURNAME.workers.dev KEY=yourpasscode node tests/flow.cjs`

## How it stays inside the free plan
The Workers Free plan allows 100,000 requests per day (Worker and Durable Object each).
Polling every 2 seconds from 40 phones for 2 hours would be about 144,000 requests, so the app does not poll.
Each phone opens one WebSocket, and the server pushes the question when it changes. Hibernation keeps the
Durable Object asleep between pushes, and keep-alive pings are answered without waking it.
A typical 40-person session uses roughly 3,000 to 5,000 requests: joins (the join screen refreshes house counts every 4 seconds), answers, reconnects, and the presenter's answer fetches.
If a phone cannot open a WebSocket, it falls back to checking every 5 seconds, and pauses while the screen is off.

## Notes
- If the Wi-Fi drops, phones show "Reconnecting…", keep what was typed, and send saved answers when the connection returns.
- Answers are stored in your Cloudflare account only. Names are first names typed by participants; clear them after the session.
- Only someone with the passcode can push questions, read all answers, or clear them. Answers are checked on the server before they are stored.
