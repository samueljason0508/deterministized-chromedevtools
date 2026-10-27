// Uses chrome-devtools-axi's page helper. No Gmail API or local send queue.
const gmail = 'https://mail.google.com/mail/u/0/';

export function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Expected a JSON object');
  for (const field of ['to', 'subject', 'body']) {
    if (typeof input[field] !== 'string' || !input[field].trim()) throw Error(`Missing ${field}`);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) throw Error('Invalid recipient address');
  if (typeof input.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::00)?(?:Z|[+-]\d\d:\d\d)$/.test(input.at) || !Number.isFinite(Date.parse(input.at))) {
    throw Error('at must be an ISO 8601 minute timestamp with an explicit UTC offset');
  }
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') throw Error('dryRun must be boolean');
}

async function until(page, label, check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) break;
    await page.wait(200);
  } while (true);
  throw Error(`Timed out waiting for ${label}`);
}

// Resolve and click within one CDP evaluation: Gmail's chat iframe mutates
// continuously, making accessibility snapshot UIDs stale before AXI can click.
async function clickNamed(page, name, roles = ['button', 'menuitem']) {
  await until(page, `${name} control`, async () => {
    const result = await page.eval(`() => {
      const roles = ${JSON.stringify(roles)};
      const name = ${JSON.stringify(name)};
      const matches = [...document.querySelectorAll('[role=\"button\"], [role=\"menuitem\"], button')]
        .filter(el => roles.includes(el.getAttribute('role') || el.tagName.toLowerCase()))
        .filter(el => el.getClientRects().length && (el.getAttribute('aria-label') || el.innerText.trim()) === name);
      if (matches.length === 1) { matches[0].click(); return 1; }
      return matches.length ? matches.length : 0;
    }`);
    if (result > 1) throw Error(`Ambiguous ${name} control: ${result} matches`);
    return result === 1;
  });
}

async function pressNamed(page, name) {
  const focused = await until(page, `${name} button`, () => page.eval(`() => {
    const matches = [...document.querySelectorAll('[role="button"], button')]
      .filter(el => el.getClientRects().length && (el.getAttribute('aria-label') || el.innerText.trim()) === ${JSON.stringify(name)});
    if (matches.length > 1) throw Error('Ambiguous button: ' + ${JSON.stringify(name)});
    if (!matches.length) return false;
    matches[0].focus();
    return document.activeElement === matches[0];
  }`));
  if (!focused) throw Error(`Cannot focus ${name}`);
  await page.press('Enter');
}

async function chooseMenuItem(page, name) {
  const count = await until(page, `${name} menu item`, () => page.eval(`() => {
    const labels = [...document.querySelectorAll('[role="menuitem"]')]
      .filter(el => el.getClientRects().length && el.innerText.trim()).map(el => el.innerText.trim());
    if (labels.filter(label => label === ${JSON.stringify(name)}).length > 1) throw Error('Ambiguous menu item');
    return labels.includes(${JSON.stringify(name)}) ? labels.length : 0;
  }`));
  for (let i = 0; i <= count; i++) {
    const active = await page.eval(`() => {
      const el = document.activeElement;
      return (document.getElementById(el?.getAttribute('aria-activedescendant')) || el)?.innerText?.trim();
    }`);
    if (active === name) {
      await page.press('Enter');
      return;
    }
    await page.press('ArrowDown');
  }
  throw Error(`Could not select ${name} by keyboard`);
}

async function focusField(page, selector) {
  await page.wait(selector);
  const focused = await page.eval(`() => {
    const matches = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(el => el.getClientRects().length);
    if (matches.length !== 1) return false;
    matches[0].click();
    matches[0].focus();
    return document.activeElement === matches[0];
  }`);
  if (!focused) throw Error(`Cannot focus exactly one ${selector} field`);
}

async function typeInto(page, selector, text) {
  await focusField(page, selector);
  await page.type(text);
}

async function replace(page, selector, text) {
  await focusField(page, selector);
  const selected = await page.eval(`() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.select();
    return document.activeElement === el && el.selectionStart === 0 && el.selectionEnd === el.value.length;
  }`);
  if (!selected) throw Error(`Could not select existing ${selector} value`);
  await page.type(text);
}

async function requireGmail(page) {
  const url = await page.eval('location.href');
  if (!String(url).startsWith(gmail)) throw Error(`Gmail login required in this AXI browser (opened ${new URL(String(url)).origin})`);
  await page.wait('[role="main"]');
}

export function planTime(at, now, dateValue, timeValue, format) {
  const target = new Date(at);
  if (!Number.isFinite(target.getTime()) || target.getTime() - now < 120000) throw Error('Schedule time must be at least two minutes in the future');
  const wall = value => `${value.getFullYear()}-${value.getMonth()}-${value.getDate()} ${value.getHours()}:${value.getMinutes()}`;
  if (wall(new Date(target.getTime() - 3600000)) === wall(target) ||
      wall(new Date(target.getTime() + 3600000)) === wall(target)) {
    throw Error('Ambiguous local time at a daylight-saving transition');
  }
  const year = target.getFullYear();
  const month = target.getMonth() + 1;
  const day = target.getDate();
  const monthName = new Intl.DateTimeFormat('en-US', { month: 'short' }).format(target);
  let date;
  if (/^[A-Za-z]{3} \d{1,2}, \d{4}$/.test(dateValue)) date = `${monthName} ${day}, ${year}`;
  else if (/^\d{1,2} [A-Za-z]{3} \d{4}$/.test(dateValue)) date = `${day} ${monthName} ${year}`;
  else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateValue) && format === 'en-US') date = `${month}/${day}/${year}`;
  else throw Error(`Unsupported Gmail date format: ${dateValue}`);
  const hour = target.getHours();
  const minute = String(target.getMinutes()).padStart(2, '0');
  const time = /[AP]M/i.test(timeValue)
    ? `${hour % 12 || 12}:${minute} ${hour < 12 ? 'AM' : 'PM'}`
    : `${String(hour).padStart(2, '0')}:${minute}`;
  return { date, time, instant: target.toISOString() };
}

export async function run(page, input) {
  validate(input);
  await page.open(gmail + '#scheduled');
  await requireGmail(page);
  // A previous successful run can have returned an error after the server commit.
  // Refuse to duplicate a visible scheduled subject; never retry blindly.
  const preflight = await until(page, 'Scheduled folder', () => page.eval(`() => {
    const main = document.querySelector('[role="main"]');
    if (!main || location.hash !== '#scheduled' ||
        !/messages in scheduled will be sent at their scheduled time/i.test(main.innerText)) return null;
    const rows = [...main.querySelectorAll('tr.zA .bog')].map(el => el.textContent.trim());
    return { rows };
  }`));
  if (preflight.rows.includes(input.subject)) throw Error('Subject already visible in Scheduled; refusing duplicate send');
  await page.open(gmail + '#inbox');
  await requireGmail(page);
  await clickNamed(page, 'Compose');
  await typeInto(page, 'input[aria-label="To recipients"]', input.to);
  await page.press('Enter');
  await typeInto(page, 'input[name="subjectbox"]', input.subject);
  await typeInto(page, '[aria-label="Message Body"][contenteditable="true"]', input.body);
  const composed = await page.eval(`() => {
    const dialog = document.querySelector('input[name="subjectbox"]')?.closest('[role="dialog"]');
    return {
      to: [...(dialog?.querySelectorAll('[email]') || [])].map(el => el.getAttribute('email')),
      subject: dialog?.querySelector('input[name="subjectbox"]')?.value,
      body: dialog?.querySelector('[aria-label="Message Body"][contenteditable="true"]')?.innerText
    };
  }`);
  if (!composed.to.includes(input.to) || composed.subject !== input.subject || composed.body !== input.body) {
    throw Error('Compose readback failed: recipient, subject or body differs');
  }
  await pressNamed(page, 'More send options');
  await chooseMenuItem(page, 'Schedule send');
  await chooseMenuItem(page, 'Select date and time');
  const picker = await until(page, 'date and time picker', () => page.eval(`() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(el => el.getClientRects().length);
    const date = dialogs.flatMap(el => [...el.querySelectorAll('input[aria-label="Date"]')]).find(el => el.getClientRects().length);
    const time = dialogs.flatMap(el => [...el.querySelectorAll('input[aria-label="Time"]')]).find(el => el.getClientRects().length);
    return date && time && date.id && time.id ? { dateId: date.id, dateValue: date.value, timeId: time.id, timeValue: time.value,
      language: document.documentElement.lang || navigator.language } : null;
  }`));
  // Run Date arithmetic in the browser so the picker and target share a timezone.
  const plan = await page.eval(`() => (${planTime.toString()})(${JSON.stringify(input.at)}, Date.now(), ${JSON.stringify(picker.dateValue)}, ${JSON.stringify(picker.timeValue)}, ${JSON.stringify(picker.language)})`);
  if (plan?.error) throw Error(plan.error);
  // Browser evaluation serializes exceptions via AXI; fail rather than guess the timezone.
  if (!plan?.instant || !plan?.date || !plan?.time) throw Error(`Cannot plan picker values: ${JSON.stringify(plan)}`);
  if (!/^[a-zA-Z][\w-]*$/.test(picker.dateId) || !/^[a-zA-Z][\w-]*$/.test(picker.timeId)) throw Error('Unsupported picker input IDs');
  await replace(page, `#${picker.dateId}`, plan.date);
  await replace(page, `#${picker.timeId}`, plan.time);
  const readback = await page.eval(`() => ({
    date: document.getElementById(${JSON.stringify(picker.dateId)})?.value,
    time: document.getElementById(${JSON.stringify(picker.timeId)})?.value
  })`);
  if (readback.date !== plan.date || readback.time !== plan.time) throw Error(`Picker readback failed: ${JSON.stringify(readback)}`);
  if (input.dryRun) return { dryRun: true, instant: plan.instant, date: plan.date, time: plan.time, note: 'Draft remains open; nothing scheduled' };
  await pressNamed(page, 'Schedule send');
  const toast = await until(page, 'Gmail schedule confirmation', async () => {
    const tree = await page.snapshot();
    return tree.match(/Send scheduled for[^\n]*/i)?.[0];
  });
  await page.open(gmail + '#scheduled');
  await requireGmail(page);
  await until(page, 'message in Scheduled', () => page.eval(`() => {
    const main = document.querySelector('[role="main"]');
    return location.hash === '#scheduled' &&
      /messages in scheduled will be sent at their scheduled time/i.test(main?.innerText || '') &&
      [...main.querySelectorAll('tr.zA .bog')].some(el => el.textContent.trim() === ${JSON.stringify(input.subject)});
  }`));
  return { scheduled: true, to: input.to, subject: input.subject, instant: plan.instant, date: plan.date, time: plan.time, toast };
}
