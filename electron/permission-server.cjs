// Minimal stdio MCP transport. Only forwards requests to this run's authenticated local bridge.
const readline = require('node:readline');
const http = require('node:http');
const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
async function requestApproval(args) {
  return new Promise(resolve => {
    const deny = () => resolve({ behavior: 'deny', message: 'cc-board 审批连接已断开或超时' });
    const body = JSON.stringify(args);
    const req = http.request({ hostname: '127.0.0.1', port: Number(process.env.CCB_PORT), path: '/approve', method: 'POST', headers: { authorization: `Bearer ${process.env.CCB_TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let text = ''; res.on('data', c => { text += c; }); res.on('end', () => { try { resolve(JSON.parse(text)); } catch { deny(); } });
    });
    req.setTimeout(600000, () => { req.destroy(); deny(); }); req.on('error', deny); req.end(body);
  });
}
readline.createInterface({ input: process.stdin }).on('line', async line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') return respond(m.id, { protocolVersion: m.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cc-board-permissions', version: process.env.CCB_VERSION || '0.3.2' } });
  if (m.method === 'ping') return respond(m.id, {});
  if (m.method === 'tools/list') return respond(m.id, { tools: [{ name: 'approve', description: 'Ask the user to approve a Claude Code tool call.', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object', additionalProperties: true } }, required: ['tool_name', 'input'] } }] });
  if (m.method === 'tools/call' && m.params?.name === 'approve') {
    const result = await requestApproval(m.params.arguments || {});
    return respond(m.id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
});
