import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { planTime, run, validate } from '../src/drivers/gmail/schedule-send.js';

const request = { to: 'reader@example.com', subject: 'Unique job update 2027-01-02', body: 'Hello', at: '2027-01-02T09:30:00-05:00' };

test('requires an unambiguous instant before touching Gmail', () => {
  assert.throws(() => validate({ ...request, at: '2027-01-02T09:30:00' }), /explicit UTC offset/);
  assert.throws(() => validate({ ...request, at: '2027-01-02T09:30:12-05:00' }), /minute timestamp/);
  assert.throws(() => validate({ ...request, to: 'not an email' }), /recipient/);
  assert.throws(() => validate({ ...request, dryRun: 'false' }), /boolean/);
});

test('picker formats the browser-local instant, not the supplied offset wall clock', () => {
  const now = Date.parse('2027-01-01T00:00:00Z');
  // This test is host-timezone independent: the target and expectation use the same local Date.
  const target = new Date(request.at);
  const expectedHour = target.getHours();
  const plan = planTime(request.at, now, 'Jan 1, 2027', '1:00 PM', 'en-US');
  assert.equal(plan.instant, target.toISOString());
  assert.equal(plan.time, `${expectedHour % 12 || 12}:${String(target.getMinutes()).padStart(2, '0')} ${expectedHour < 12 ? 'AM' : 'PM'}`);
  assert.equal(plan.date, `${new Intl.DateTimeFormat('en-US', { month: 'short' }).format(target)} ${target.getDate()}, ${target.getFullYear()}`);
  assert.equal(planTime(request.at, now, '1 Jan 2027', '13:00', 'en-GB').time, `${String(expectedHour).padStart(2, '0')}:30`);
});

test('rejects near-term times and unfamiliar date formats rather than guessing', () => {
  const instant = Date.parse(request.at);
  assert.throws(() => planTime(request.at, instant - 60000, 'Jan 1, 2027', '1:00 PM', 'en-US'), /two minutes/);
  assert.throws(() => planTime(request.at, 0, '01.01.2027', '1:00 PM', 'en-US'), /Unsupported/);
});

test('rejects both occurrences of a repeated daylight-saving wall time', () => {
  const script = `import { planTime } from ${JSON.stringify(new URL('../src/drivers/gmail/schedule-send.js', import.meta.url).href)};
for (const instant of ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z']) {
  try { planTime(instant, 0, 'Nov 1, 2026', '1:00 AM', 'en-US'); process.exit(1); }
  catch (error) { if (!/Ambiguous local time/.test(error.message)) throw error; }
}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
});

test('login redirect aborts without composing or scheduling', async () => {
  const calls = [];
  const page = {
    open: async url => calls.push(['open', url]),
    eval: async () => 'https://accounts.google.com/signin',
    wait: async () => { throw Error('should not wait on login page'); },
    click: async () => { throw Error('should not click on login page'); }
  };
  await assert.rejects(run(page, request), /Gmail login required/);
  assert.deepEqual(calls, [['open', 'https://mail.google.com/mail/u/0/#scheduled']]);
});

test('known Scheduled subject aborts before opening a compose', async () => {
  const pages = [];
  const page = {
    open: async url => pages.push(url),
    eval: async source => source === 'location.href' ? 'https://mail.google.com/mail/u/0/#scheduled' : { rows: [{ subject: request.subject, to: request.to }] },
    wait: async () => {},
    click: async () => { throw Error('must not compose duplicate'); }
  };
  await assert.rejects(run(page, request), /refusing duplicate/);
  assert.deepEqual(pages, ['https://mail.google.com/mail/u/0/#scheduled']);
});
