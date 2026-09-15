const { StringDecoder } = require('node:string_decoder');
const { randomUUID } = require('node:crypto');
const MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];
function lineDecoder(onEvent, onInvalid = () => {}) {
  const decoder = new StringDecoder('utf8'); let buffer = '';
  function consume(s) { buffer += s; let i; while ((i = buffer.indexOf('\n')) >= 0) { parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); } if (buffer.length > 16 * 1024 * 1024) throw Error('CLI 单条消息超过 16 MB'); }
  function parse(line) { if (!line.trim()) return; let event; try { event = JSON.parse(line); } catch { onInvalid(line); return; } onEvent(event); }
  return { write(chunk) { consume(decoder.write(chunk)); }, end() { consume(decoder.end()); if (buffer.trim()) parse(buffer); buffer = ''; } };
}
function argumentsFor({ session, mode, model, mcp }) {
  if (!MODES.includes(mode)) throw Error('不支持的权限模式');
  const args = ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--permission-mode', mode];
  if (session) args.push('--resume', session);
  if (model) args.push('--model', model);
  if (mcp && mode !== 'bypassPermissions') args.push('--mcp-config', JSON.stringify(mcp), '--permission-prompt-tool', 'mcp__ccboard__approve');
  return args;
}
function normalize(event) {
  if (event.type === 'system' && event.session_id) return { kind: 'session', sessionId: event.session_id };
  if (event.type === 'stream_event') {
    const e = event.event;
    if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') return { kind: 'delta', text: e.delta.text };
  }
  if (event.type === 'assistant') return { kind: 'assistant', content: event.message?.content || [] };
  if (event.type === 'user') return { kind: 'tool_result', content: event.message?.content || [] };
  if (event.type === 'result') return { kind: 'result', error: Boolean(event.is_error), text: event.result || event.errors?.join('\n') || '', usage: event.usage || null, cost: Number.isFinite(event.total_cost_usd) ? event.total_cost_usd : null, denials: event.permission_denials || [] };
  return null;
}
function providerEnv(profile, decrypt) {
  if (!profile || profile.id === 'native') return {};
  const env = { ...profile.extraEnv, ANTHROPIC_BASE_URL: profile.baseUrl };
  if (profile.secret) env[profile.authType === 'apiKey' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'] = decrypt(profile.secret);
  if (profile.model) env.ANTHROPIC_MODEL = profile.model;
  return env;
}
function isNewerVersion(latest, current) {
  const parse = (value) => {
    const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)/i);
    return match ? match.slice(1).map(Number) : null;
  };
  const next = parse(latest);
  const installed = parse(current);
  if (!next || !installed) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== installed[index]) return next[index] > installed[index];
  }
  return false;
}
function id() { return randomUUID(); }
module.exports = { lineDecoder, argumentsFor, normalize, MODES, providerEnv, isNewerVersion, id };
