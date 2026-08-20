// mock OpenAI 兼容 endpoint：第一轮返回 patch_blocks 工具调用，第二轮返回文本
import http from 'node:http';

const server = http.createServer(async (req, res) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'mock-model-pro' }] }));
    return;
  }
  if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const { messages } = JSON.parse(body);
    const hasToolResult = messages.some(m => m.role === 'tool');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
    if (!hasToolResult) {
      res.write(chunk({ role: 'assistant', content: '好的，我来修改这段。' }));
      res.write(chunk({
        tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'patch_blocks', arguments: '{"patches":[{"id":"b4","newText":"本方案为智慧园区建设提供【AI 修订】整体规划。"}]}' } }],
      }, 'tool_calls'));
    } else {
      res.write(chunk({ content: '已完成修改并落盘。' }, 'stop'));
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
server.listen(4100, () => console.log('mock llm on :4100'));
