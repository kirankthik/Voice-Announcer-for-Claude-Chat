#!/usr/bin/env node
/**
 * Voice Announcer: a small MCP server for Claude Desktop on macOS.
 *
 * At the end of a reply Claude calls `announce_reply`, and this speaks
 * "Claude has responded to chat titled <title>" and/or reads the reply aloud
 * with the Mac's built-in `say` command (plus an optional chime via `afplay`).
 *
 * No dependencies and no network access: text only ever goes to `say`.
 * Settings come from the extension's settings screen, passed in as VA_* env vars.
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const readline = require('node:readline');

const SERVER = { name: 'voice-announcer', title: 'Voice Announcer for Claude Chat', version: '1.0.3' };

// ---------------------------------------------------------------- settings --

function setting(name) {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = String(raw).trim();
  // Empty, or a placeholder the app left unsubstituted, counts as "not set".
  if (value === '' || /^\$\{.*\}$/.test(value)) return undefined;
  return value;
}
const bool = (name, fallback) => {
  const v = setting(name);
  return v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v);
};
const num = (name, fallback, lo, hi) => {
  const v = setting(name);
  const n = Number(v);
  if (v === undefined || !Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};
const str = (name, fallback) => setting(name) ?? fallback;

const CONFIG = {
  announce: bool('VA_ANNOUNCE', true),
  readReply: bool('VA_READ_REPLY', false),
  template: str('VA_TEMPLATE', 'Claude has responded to chat titled {title}'),
  voice: str('VA_VOICE', ''),
  rate: num('VA_RATE', 0, 0, 720),
  chime: str('VA_CHIME', 'Glass'),
  maxWords: num('VA_MAX_WORDS', 200, 0, 5000),
};

// Overridable only for testing; Claude Desktop never sets these.
const SAY = process.env.VA_SAY_BIN || '/usr/bin/say';
const AFPLAY = process.env.VA_AFPLAY_BIN || '/usr/bin/afplay';
const CAN_SPEAK = process.platform === 'darwin' || Boolean(process.env.VA_SAY_BIN);
const MAX_WAITING = 8;

// ------------------------------------------------------------ text helpers --

/** Turns markdown-ish reply text into something pleasant to hear. */
function forSpeech(input) {
  let t = String(input ?? '').replace(/\r\n?/g, '\n');
  t = t.replace(/```[\s\S]*?(?:```|$)/g, '\n(There is code in the chat.)\n');
  t = t.replace(/`([^`\n]+)`/g, '$1');
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/<https?:\/\/[^>\s]+>/g, 'a link');
  t = t.replace(/https?:\/\/[^\s)]+/g, 'a link');
  t = t.replace(/<\/?[a-z][^>]*>/gi, ' ');
  t = t.replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, ''); // table rules
  t = t.replace(/^\s*(?:[-*_]\s*){3,}$/gm, ''); // horizontal rules
  t = t.replace(/^\s*\|/gm, '').replace(/\|\s*$/gm, '').replace(/\s*\|\s*/g, ', ');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s*>\s?/gm, '');
  t = t.replace(/^\s*[-*+•]\s+/gm, '');
  t = t.replace(/(\*\*|__)(.+?)\1/g, '$2');
  t = t.replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,!?:;]|$)/gm, '$1$2');
  t = t.replace(/~~(.+?)~~/g, '$1');
  t = t.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '');
  // Give every line an ending so the voice pauses between lines.
  return t
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .filter(Boolean)
    .map((line) => (/[.!?:;,]$/.test(line) ? line : `${line}.`))
    .join('\n');
}

/** Keeps a read-aloud from running far past the length set in Settings. */
function capWords(text, maxWords) {
  if (!maxWords) return text;
  const limit = Math.max(40, Math.round(maxWords * 1.5));
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= limit) return text;
  let cut = words.slice(0, limit).join(' ');
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  if (end > cut.length * 0.5) cut = cut.slice(0, end + 1);
  return `${cut} That's the gist. The rest is in the chat.`;
}

function cleanTitle(raw) {
  let title = forSpeech(raw).replace(/\n+/g, ' ');
  title = title.replace(/^["'“”‘’\s]+/, '').replace(/["'“”‘’.,;:\s]+$/, '');
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length > 12) title = words.slice(0, 12).join(' ');
  return title || 'untitled';
}

function announcement(title, needsInput) {
  let line = CONFIG.template.replace(/\{title\}/g, title).trim();
  if (needsInput) line = `${line.replace(/[.!?\s]+$/, '')}. It has a question for you.`;
  return line;
}

// ---------------------------------------------------------------- playback --

let waiting = []; // jobs not yet started; each job is a list of steps
let busy = false;
let current = null; // the running say/afplay process
let generation = 0; // bumped by stop_speaking so in-flight jobs give up
let voiceUsable = true;

function log(message) {
  process.stderr.write(`[voice-announcer] ${message}\n`);
}

function run(command, args, input) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    current = child;
    let stderr = '';
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      if (current === child) current = null;
      resolve(value);
    };
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on('error', (err) => settle({ ok: false, error: err.message }));
    child.on('exit', (code, signal) => {
      if (current === child) current = null;
      // 'close' normally follows at once; don't hang on pipes something else still holds.
      setTimeout(() => settle({ ok: code === 0, code, signal, error: stderr.trim() }), 250);
    });
    child.on('close', (code, signal) => settle({ ok: code === 0, code, signal, error: stderr.trim() }));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

async function speak(text) {
  if (!text) return;
  const rate = CONFIG.rate > 0 ? ['-r', String(CONFIG.rate)] : [];
  const voice = CONFIG.voice && voiceUsable ? ['-v', CONFIG.voice] : [];
  let result = await run(SAY, [...voice, ...rate], text);
  if (!result.ok && !result.signal && voice.length && /voice/i.test(result.error || '')) {
    log(`Voice "${CONFIG.voice}" isn't installed (${result.error}). Using the system voice.`);
    voiceUsable = false;
    result = await run(SAY, rate, text);
  }
  if (!result.ok && !result.signal) log(`say failed: ${result.error || `exit ${result.code}`}`);
}

let chimeWarned = false;
async function chime() {
  const name = (CONFIG.chime || '').trim();
  if (!name || /^(none|off|no|false)$/i.test(name)) return;
  const file = name.includes('/')
    ? name
    : `/System/Library/Sounds/${name.replace(/\.aiff$/i, '')}.aiff`;
  if (!fs.existsSync(file)) {
    if (!chimeWarned) log(`Chime "${name}" not found at ${file}; skipping the chime.`);
    chimeWarned = true;
    return;
  }
  await run(AFPLAY, [file], '');
}

async function drain() {
  if (busy) return;
  busy = true;
  try {
    while (waiting.length) {
      const job = waiting.shift();
      const mine = generation;
      for (const step of job) {
        if (mine !== generation) break;
        try {
          await step();
        } catch (err) {
          log(`playback step failed: ${err.message}`);
        }
      }
    }
  } finally {
    busy = false;
  }
}

function enqueue(job) {
  if (waiting.length >= MAX_WAITING) waiting.shift();
  waiting.push(job);
  drain();
}

function stopAll() {
  const hadSomething = Boolean(current) || waiting.length > 0;
  generation += 1;
  waiting = [];
  if (current) {
    try {
      current.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  return hadSomething;
}

// ------------------------------------------------------------------- tools --

const INSTRUCTIONS =
  "Voice Announcer speaks on the user's Mac when your reply is ready, so they can step away while you work. " +
  'Call announce_reply once per reply as your last tool call: after all other work and tool calls, right before you write your final answer. ' +
  'Then write your answer as usual; never end a reply on the tool call. Call stop_speaking if the user asks you to be quiet.';

function toolList() {
  const example = CONFIG.template.replace(/\{title\}/g, 'Lisbon trip plan');
  const about = [
    "Speaks out loud on the user's Mac so they know your reply is ready while they are away from the screen; the user installed this so they can send a prompt and walk away.",
    'Call it exactly once per reply, as your last tool call: after all other work and tool calls, right before you write your final answer to the user. Then write that answer as usual; never end your reply on this call.',
  ];
  if (CONFIG.announce) about.push(`It announces: "${example}", using your chat_title.`);
  if (CONFIG.readReply) about.push(`${CONFIG.announce ? 'Then it' : 'It'} reads spoken_text aloud.`);
  if (!CONFIG.announce && !CONFIG.readReply) about.push('Both voice options are switched off in its settings right now, so it stays silent.');

  const properties = {
    chat_title: {
      type: 'string',
      description:
        "This chat's title as the user's chat list shows it, or if you can't see that, a 2-6 word name for the chat's topic (e.g. \"Lisbon trip plan\"). Use the exact same title every time you call this in the same chat.",
    },
    needs_input: {
      type: 'boolean',
      description:
        'true only if you cannot go on until the user answers: you asked them a question you need answered, or need their decision or approval. ' +
        'false for a finished answer, including one that just offers optional next steps ("want me to…?").',
    },
  };
  // spoken_text is always in the schema: a chat that listed this tool before read-aloud was
  // switched on keeps the schema it first saw, so it must already carry this field.
  properties.spoken_text = {
    type: 'string',
    description:
      (CONFIG.maxWords > 0
        ? `The answer you are about to write, rewritten for listening, under ${CONFIG.maxWords} words. If it is longer, give the key points and say the details are in the chat.`
        : 'The whole answer you are about to write, rewritten for listening.') +
      ' Use plain spoken sentences: no markdown, code, tables, links or emoji. Always include, word for word, any question you are asking the user.' +
      ' Always send it: the user can switch read-aloud on at any time, and it is ignored while read-aloud is off.',
  };
  const required = ['chat_title', 'spoken_text'];

  const quiet = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  return [
    {
      name: 'announce_reply',
      title: 'Announce reply',
      description: about.join(' '),
      inputSchema: { type: 'object', properties, required, additionalProperties: false },
      annotations: { title: 'Announce reply', ...quiet, idempotentHint: false },
    },
    {
      name: 'stop_speaking',
      title: 'Stop speaking',
      description:
        'Stops any announcement or read-aloud playing on the Mac and clears anything waiting to be spoken. Use it when the user says stop, quiet, or enough.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Stop speaking', ...quiet, idempotentHint: true },
    },
  ];
}

const result = (text, isError = false) => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
});

function callTool(name, rawArgs) {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  if (name === 'stop_speaking') return result(stopAll() ? 'Stopped.' : 'Nothing was playing.');
  if (name !== 'announce_reply') return result(`Unknown tool: ${name}`, true);
  if (!CAN_SPEAK) return result('Voice Announcer only works on macOS, so nothing was spoken.', true);
  if (!CONFIG.announce && !CONFIG.readReply) {
    return result('Voice is switched off in the Voice Announcer settings, so nothing was spoken. Write your answer to the user as usual.');
  }

  const title = cleanTitle(args.chat_title);
  const needsInput = args.needs_input === true || args.needs_input === 'true';
  const lines = [];
  if (CONFIG.announce) lines.push(announcement(title, needsInput));
  if (CONFIG.readReply) {
    const body = capWords(forSpeech(args.spoken_text), CONFIG.maxWords);
    if (body) lines.push(body);
    else {
      log('Read-aloud is on but Claude sent no spoken_text; start a new chat so it picks up the current tool.');
      if (!CONFIG.announce) lines.push(announcement(title, needsInput));
    }
  }
  enqueue([chime, ...lines.map((line) => () => speak(line))]);
  return result('Queued to speak on the Mac. Now write your answer to the user as usual.');
}

// ---------------------------------------------------------------- JSON-RPC --

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
const reply = (id, value) => send({ jsonrpc: '2.0', id, result: value });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

function handle(message) {
  if (Array.isArray(message)) {
    message.forEach(handle);
    return;
  }
  if (!message || typeof message !== 'object' || typeof message.method !== 'string') return;
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER,
          instructions: INSTRUCTIONS,
        });
        return;
      case 'ping':
        if (isRequest) reply(id, {});
        return;
      case 'tools/list':
        reply(id, { tools: toolList() });
        return;
      case 'tools/call':
        reply(id, callTool(params?.name, params?.arguments));
        return;
      case 'resources/list':
        reply(id, { resources: [] });
        return;
      case 'prompts/list':
        reply(id, { prompts: [] });
        return;
      default:
        if (isRequest && !method.startsWith('notifications/')) fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    log(`error handling ${method}: ${err?.stack || err}`);
    if (isRequest) fail(id, -32603, 'Internal error');
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail(null, -32700, 'Parse error');
    return;
  }
  handle(message);
});
input.on('close', () => {
  stopAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopAll();
  process.exit(0);
});
process.on('uncaughtException', (err) => log(`unexpected error: ${err?.stack || err}`));

log(
  `ready: announce=${CONFIG.announce} readReply=${CONFIG.readReply} voice=${CONFIG.voice || '(system)'} ` +
    `rate=${CONFIG.rate || '(default)'} chime=${CONFIG.chime || '(none)'} maxWords=${CONFIG.maxWords}`,
);
