// End-to-end tests for the Voice Announcer server: speaks MCP over stdio like
// Claude Desktop does, with mock `say` / `afplay` that record what they were asked.
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const SERVER = path.join(__dirname, '..', 'server', 'index.js');
const T = __dirname;
const SAY = path.join(T, 'bin/say');
const AFPLAY = path.join(T, 'bin/afplay');
const IOREG = path.join(T, 'bin/ioreg');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.writeFileSync(path.join(T, 'Ding.aiff'), 'stand-in chime'); // the chime test plays this file

// Unsubstituted placeholders, as an app might pass for settings left unset.
const UNSET = {
  VA_ANNOUNCE: '${user_config.announce}',
  VA_READ_REPLY: '${user_config.read_reply}',
  VA_TEMPLATE: '${user_config.announcement}',
  VA_VOICE: '${user_config.voice}',
  VA_RATE: '${user_config.rate}',
  VA_CHIME: '${user_config.chime}',
  VA_MAX_WORDS: '${user_config.max_words}',
};

function start(env, { mocks = true } = {}) {
  const log = path.join(T, `log-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(log, '');
  const child = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH,
      MOCK_LOG: log,
      ...(mocks ? { VA_SAY_BIN: SAY, VA_AFPLAY_BIN: AFPLAY, VA_IOREG_BIN: IOREG } : {}),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  let stderr = '';
  const pending = new Map();
  const stray = [];
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line); // every stdout line must be valid JSON-RPC
      if (pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else stray.push(msg);
    }
  });
  child.stderr.on('data', (d) => (stderr += d));
  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => reject(new Error(`timeout on ${method}`)), 4000);
    });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const raw = (s) => child.stdin.write(s + '\n');
  const calls = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const stop = () => new Promise((r) => { child.on('exit', r); child.stdin.end(); });
  return { child, rpc, notify, raw, calls, stop, stderr: () => stderr, stray };
}

async function handshake(s) {
  const init = await s.rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-desktop', version: '0' },
  });
  s.notify('notifications/initialized');
  return init;
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (err) {
    results.push(['FAIL', name, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err)]);
  }
}

(async () => {
  await test('handshake, tool list and defaults (announce only)', async () => {
    const s = start({ ...UNSET });
    const init = await handshake(s);
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    assert.equal(init.result.serverInfo.name, 'voice-announcer');
    assert.match(init.result.instructions, /announce_reply/);
    const list = await s.rpc('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    assert.deepEqual(names, ['announce_reply', 'stop_speaking']);
    const ann = list.result.tools[0];
    assert.deepEqual(Object.keys(ann.inputSchema.properties), ['chat_title', 'needs_input', 'spoken_text']);
    assert.deepEqual(ann.inputSchema.required, ['chat_title', 'spoken_text']);
    assert.match(ann.description, /Claude has responded to chat titled Lisbon trip plan/);
    assert.equal(ann.annotations.readOnlyHint, true);

    const r = await s.rpc('tools/call', { name: 'announce_reply', arguments: { chat_title: 'Lisbon trip plan', needs_input: false } });
    assert.equal(r.result.isError, undefined);
    assert.match(r.result.content[0].text, /Queued/);
    assert.match(r.result.content[0].text, /write your answer/);
    assert.ok(!/without writing/.test(ann.description), 'old end-your-turn wording still present');
    assert.match(ann.description, /right before you write your final answer/);
    await sleep(400);
    assert.deepEqual(s.calls(), ['SAY args=[] text=[Claude has responded to chat titled Lisbon trip plan]']);
    assert.match(s.stderr(), /Chime "Glass" not found/); // no macOS sounds on this Linux box
    assert.match(s.stderr(), /announce=true readReply=false voice=\(system\)/);
    await s.stop();
  });

  await test('needs_input, messy title, chime from a file path, voice and rate', async () => {
    const s = start({ VA_CHIME: path.join(T, 'Ding.aiff'), VA_VOICE: 'Samantha', VA_RATE: '230', VA_ANNOUNCE: 'true', VA_READ_REPLY: 'false' });
    await handshake(s);
    await s.rpc('tools/call', { name: 'announce_reply', arguments: { chat_title: '  "**Budget** for Q4 🚀."  ', needs_input: true } });
    await sleep(400);
    assert.deepEqual(s.calls(), [
      `AFPLAY ${path.join(T, 'Ding.aiff')}`,
      'SAY args=[-v Samantha -r 230] text=[Claude has responded to chat titled Budget for Q4. It has a question for you.]',
    ]);
    await s.stop();
  });

  await test('read-aloud: markdown cleaned, questions kept, announcement first', async () => {
    const s = start({ VA_READ_REPLY: 'true', VA_CHIME: 'none', VA_MAX_WORDS: '200' });
    await handshake(s);
    const list = await s.rpc('tools/list', {});
    const ann = list.result.tools[0];
    assert.deepEqual(ann.inputSchema.required, ['chat_title', 'spoken_text']);
    assert.match(ann.inputSchema.properties.spoken_text.description, /under 200 words/);
    const md = [
      '## Plan',
      '- **Day 1**: Alfama and the [castle](https://example.com/castle)',
      '- *Day 2*: Belém, see `tram 15`',
      '',
      '| Day | Area |',
      '|---|---|',
      '| 3 | Sintra |',
      '',
      '```js',
      'console.log("hi")',
      '```',
      'Should I book the Sintra train? 🙂',
    ].join('\n');
    await s.rpc('tools/call', { name: 'announce_reply', arguments: { chat_title: 'Lisbon trip plan', spoken_text: md } });
    await sleep(500);
    const calls = s.calls();
    assert.equal(calls.length, 2, calls.join('\n'));
    assert.equal(calls[0], 'SAY args=[] text=[Claude has responded to chat titled Lisbon trip plan]');
    const body = calls[1];
    for (const gone of ['##', '**', '`', 'https', '|', '---', 'console.log', '🙂']) assert.ok(!body.includes(gone), `still has ${gone}: ${body}`);
    for (const kept of ['Plan.', 'Day 1: Alfama and the castle', 'Day 2: Belém, see tram 15', 'Day, Area', '3, Sintra', '(There is code in the chat.)', 'Should I book the Sintra train?']) assert.ok(body.includes(kept), `missing "${kept}": ${body}`);
    await s.stop();
  });

  await test('read-aloud only (announce off) and long text is capped', async () => {
    const s = start({ VA_ANNOUNCE: 'false', VA_READ_REPLY: 'true', VA_CHIME: 'none', VA_MAX_WORDS: '30' });
    await handshake(s);
    const sentences = Array.from({ length: 30 }, (_, i) => `This is sentence number ${i + 1} of the reply.`).join(' ');
    await s.rpc('tools/call', { name: 'announce_reply', arguments: { chat_title: 'Long one', spoken_text: sentences } });
    await sleep(400);
    const calls = s.calls();
    assert.equal(calls.length, 1, calls.join('\n'));
    assert.ok(!calls[0].includes('has responded'), 'announcement should be off');
    assert.match(calls[0], /That's the gist\. The rest is in the chat\.\]$/);
    const words = calls[0].replace(/^SAY args=\[\] text=\[|\]$/g, '').split(/\s+/).length;
    assert.ok(words <= 45 + 8, `too many words: ${words}`);
    // Missing spoken_text in read-only mode falls back to the announcement.
    await s.rpc('tools/call', { name: 'announce_reply', arguments: { chat_title: 'Fallback' } });
    await sleep(300);
    assert.equal(s.calls()[1], 'SAY args=[] text=[Claude has responded to chat titled Fallback]');
    await s.stop();
  });

  await test('unknown voice falls back to the system voice', async () => {
    const s = start({ VA_VOICE: 'BadVoice', VA_CHIME: 'none' });
    await handshake(s);
    await s.rpc('tools/call', { name: 'announce_reply', arguments: { chat_title: 'Voices' } });
    await sleep(400);
    await s.rpc('tools/call', { name: 'announce_reply', arguments: { chat_title: 'Voices again' } });
    await sleep(400);
    assert.deepEqual(s.calls(), [
      'SAY args=[] text=[Claude has responded to chat titled Voices]',
      'SAY args=[] text=[Claude has responded to chat titled Voices again]',
    ]);
    assert.match(s.stderr(), /Voice "BadVoice" isn't installed/);
    await s.stop();
  });

  await test('announcements queue in order; stop_speaking cuts off and clears', async () => {
    const s = start({ VA_CHIME: 'none', VA_TEMPLATE: 'Done: {title}' });
    await handshake(s);
    await s.rpc('tools/call', { name: 'announce_reply', arguments: { chat_title: 'First' } });
    await s.rpc('tools/call', { name: 'announce_reply', arguments: { chat_title: 'Second' } });
    await sleep(500);
    assert.deepEqual(s.calls(), ['SAY args=[] text=[Done: First]', 'SAY args=[] text=[Done: Second]']);
    // A slow utterance, then one queued behind it; stop cancels both.
    await s.rpc('tools/call', { name: 'announce_reply', arguments: { chat_title: 'SLOW one' } });
    await s.rpc('tools/call', { name: 'announce_reply', arguments: { chat_title: 'Never spoken' } });
    await sleep(300);
    const r = await s.rpc('tools/call', { name: 'stop_speaking', arguments: {} });
    assert.equal(r.result.content[0].text, 'Stopped.');
    await sleep(800);
    const calls = s.calls();
    assert.ok(calls.includes('SAY args=[] text=[Done: SLOW one]'), calls.join('\n'));
    assert.ok(!calls.some((c) => c.includes('Never spoken')), 'queued item should be cleared');
    assert.ok(!calls.includes('SAY-FINISHED-SLOW'), 'slow utterance should be cut off');
    const again = await s.rpc('tools/call', { name: 'stop_speaking', arguments: {} });
    assert.equal(again.result.content[0].text, 'Nothing was playing.');
    // Still works after a stop.
    await s.rpc('tools/call', { name: 'announce_reply', arguments: { chat_title: 'After stop' } });
    await sleep(400);
    assert.equal(s.calls().at(-1), 'SAY args=[] text=[Done: After stop]');
    await s.stop();
  });

  await test('a key press or mouse move stops speaking (and the setting can turn that off)', async () => {
    const idleFile = path.join(T, 'log-idle.txt');
    fs.writeFileSync(idleFile, '999999');
    const s = start({ VA_CHIME: 'none', MOCK_IDLE_FILE: idleFile });
    await handshake(s);
    await s.rpc('tools/call', { name: 'announce_reply', arguments: { chat_title: 'SLOW one', spoken_text: 'x' } });
    await s.rpc('tools/call', { name: 'announce_reply', arguments: { chat_title: 'Never spoken', spoken_text: 'x' } });
    await sleep(700);
    fs.writeFileSync(idleFile, '0'); // the user just touched the keyboard
    await sleep(900);
    let calls = s.calls();
    assert.ok(calls.some((c) => c.includes('SLOW one')), calls.join('\n'));
    assert.ok(!calls.some((c) => c.includes('Never spoken')), 'queued item should be cleared');
    assert.ok(!calls.includes('SAY-FINISHED-SLOW'), 'speech should be cut off');
    assert.match(s.stderr(), /Stopped speaking: keyboard or mouse activity/);
    // Activity from before playback started does not stop it.
    fs.writeFileSync(idleFile, '999999');
    await s.rpc('tools/call', { name: 'announce_reply', arguments: { chat_title: 'Next', spoken_text: 'x' } });
    await sleep(500);
    assert.ok(s.calls().some((c) => c.includes('Next')));
    await s.stop();

    fs.writeFileSync(idleFile, '999999');
    const off = start({ VA_CHIME: 'none', MOCK_IDLE_FILE: idleFile, VA_STOP_ON_ACTIVITY: 'false' });
    await handshake(off);
    await off.rpc('tools/call', { name: 'announce_reply', arguments: { chat_title: 'SLOW again', spoken_text: 'x' } });
    await sleep(500);
    fs.writeFileSync(idleFile, '0');
    await sleep(800);
    assert.ok(!/Stopped speaking/.test(off.stderr()), 'should keep speaking when the setting is off');
    await off.rpc('tools/call', { name: 'stop_speaking', arguments: {} });
    await off.stop();
  });

  await test('both options off: silent, tool says so', async () => {
    const s = start({ VA_ANNOUNCE: 'false', VA_READ_REPLY: 'false', VA_CHIME: 'none' });
    await handshake(s);
    const list = await s.rpc('tools/list', {});
    assert.match(list.result.tools[0].description, /switched off/);
    const r = await s.rpc('tools/call', { name: 'announce_reply', arguments: { chat_title: 'x' } });
    assert.match(r.result.content[0].text, /switched off/);
    await sleep(300);
    assert.deepEqual(s.calls(), []);
    await s.stop();
  });

  await test('protocol edges: ping, unknown method, parse error, notifications, unknown tool, other protocol version', async () => {
    const s = start({ ...UNSET });
    const init = await s.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-11-25');
    s.notify('notifications/initialized');
    assert.deepEqual((await s.rpc('ping', {})).result, {});
    const unknown = await s.rpc('sampling/whatever', {});
    assert.equal(unknown.error.code, -32601);
    s.raw('{not json');
    await sleep(150);
    assert.equal(s.stray.at(-1).error.code, -32700);
    s.notify('notifications/cancelled', { requestId: 99 });
    const bad = await s.rpc('tools/call', { name: 'nope', arguments: {} });
    assert.equal(bad.result.isError, true);
    assert.deepEqual((await s.rpc('resources/list', {})).result, { resources: [] });
    assert.deepEqual((await s.rpc('prompts/list', {})).result, { prompts: [] });
    const exit = await s.stop();
    assert.equal(exit, 0);
  });

  await test('not on a Mac and no say: reports an error instead of crashing', async () => {
    const s = start({ ...UNSET }, { mocks: false });
    await handshake(s);
    const r = await s.rpc('tools/call', { name: 'announce_reply', arguments: { chat_title: 'x' } });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /only works on macOS/);
    await s.stop();
  });

  for (const [status, name, detail] of results) console.log(`${status}  ${name}${detail ? `\n      ${detail}` : ''}`);
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
