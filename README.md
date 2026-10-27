# Deterministized Chrome DevTools

Small, fail-closed workflows using the actual [`chrome-devtools-axi run`](https://github.com/kunchenguid/chrome-devtools-axi) browser helper. No Gmail API, local email queue, scheduler daemon or separate Puppeteer browser.

## Setup

Requires Node.js 20+ and `chrome-devtools-axi` on `PATH`. Sign in to Gmail in the **same AXI browser session** first. AXI normally uses an isolated Chrome profile, not your everyday browser. Configure its persistent profile with `CHROME_DEVTOOLS_AXI_USER_DATA_DIR`, attach to an authorized Chrome with `CHROME_DEVTOOLS_AXI_AUTO_CONNECT=1`, or point `CHROME_DEVTOOLS_AXI_BROWSER_URL` at an existing authorized CDP endpoint. For a running Chrome Dev instance, set `CHROME_DEVTOOLS_AXI_CHANNEL=dev` when connecting/launching. See `chrome-devtools-axi --help` for these connection modes. Keep `CHROME_DEVTOOLS_AXI_SESSION` the same for setup and execution. Do not copy cookies or credentials into this repository.

Create a private request file outside the repository:

```json
{
  "to": "recipient@example.com",
  "subject": "Unique update 2027-01-02",
  "body": "Hello from Gmail.",
  "at": "2027-01-02T09:30:00-05:00",
  "dryRun": true
}
```

Run `node bin/run.js gmail/schedule-send --input /path/to/request.json`. With `dryRun: true`, the driver stops at the date/time picker and leaves an unsent draft; inspect or discard the draft in Gmail. Remove `dryRun` to request a real native Schedule send. The timestamp **must contain an offset**, be at least two minutes in the future, and the browser's timezone determines the date/time displayed in Gmail. The driver refuses a matching recipient and subject visible in the Scheduled folder. It is not an exactly-once guarantee across folder pagination or concurrent invocations. Do not retry after an ambiguous error without checking Scheduled manually.

On success the command prints JSON only after Gmail's schedule confirmation matches the requested time and the recipient/subject appears in Scheduled. Nonzero exit means it could not verify completion; it does **not** prove no message was scheduled. Login redirects, unknown date formats, missing controls, readback mismatches and timeouts stop rather than guessing. `npm test` checks validation, time conversion, login abort and duplicate abort without sending mail.

## Add another driver

Create `src/drivers/<app>/<workflow>.js` exporting `validate(input)` and `async run(page, input)`. The runner discovers this path from the CLI name `<app>/<workflow>`, validates input before launching AXI, then imports the module into AXI's `run` script. The `page` argument is AXI's documented helper (`open`, `eval`, `wait`, `snapshot`, `click`, `fill`, `type`, `press`, `back`). Keep app-specific selectors and assertions in the driver; fail closed on ambiguous UI or unknown state. Add behavioral tests in `test/`. No runner registration or dependencies needed.
