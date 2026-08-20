// MCP 链路测试：直接驱动 mcp-manager（不经 http 服务）
import { reloadMcp, getStatus, mcpToolSchemas, callMcpTool, saveConfig } from './server/mcp-manager.js';

let pass = 0, fail = 0;
const assert = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name); };

await saveConfig({ servers: { devtest: { type: 'stdio', command: 'node', args: ['dev-mock-mcp.mjs'], enabled: true } } });
await reloadMcp();
const st = getStatus();
assert('MCP 连接成功', st.devtest?.ok === true);
assert('发现 1 个工具', st.devtest?.toolCount === 1);
const schemas = mcpToolSchemas();
assert('工具并入命名空间', schemas.some(s => s.function.name === 'mcp__devtest__echo'));
const out = await callMcpTool('mcp__devtest__echo', { text: 'hello mcp' });
assert('工具调用返回', out.includes('ECHO: hello mcp'));

console.log(`\nRESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
