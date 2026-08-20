// 最小 stdio MCP server：1 个工具 echo（供集成测试）
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      reply(msg.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'dev-mcp', version: '0.0.1' } });
    } else if (msg.method === 'tools/list') {
      reply(msg.id, { tools: [{ name: 'echo', description: '回声测试', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
    } else if (msg.method === 'tools/call') {
      reply(msg.id, { content: [{ type: 'text', text: 'ECHO: ' + (msg.params?.arguments?.text || '') }] });
    }
    // notifications 无需响应
  }
});
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
