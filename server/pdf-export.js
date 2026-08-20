// PDF 导出：无头 Chrome 打开预览页（?pdf=1 纯净模式）→ CDP printToPDF
// 分页与预览同一套 Paged Media CSS，所见即所得；页眉页脚页码以 DOM 形式保留
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let queue = Promise.resolve(); // 打印任务串行（v1 简单流控）
let portSeq = 9333;

export function exportPdf(docId, baseUrl) {
  // 排队执行，避免并发抢调试端口
  const job = queue.then(() => doExportPdf(docId, baseUrl)).catch(e => { throw e; });
  queue = job.catch(() => {});
  return job;
}

async function doExportPdf(docId, baseUrl) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('未找到 Chrome/Chromium：PDF 导出需要本机安装 Chrome（或设 CHROME_PATH）');
  const port = portSeq++;
  const chrome = spawn(chromePath, [
    '--headless', '--disable-gpu', `--remote-debugging-port=${port}`,
    `--user-data-dir=/tmp/ws-pdf-profile-${port}`, 'about:blank',
  ], { stdio: 'ignore' });

  try {
    // 等 CDP 就绪（Chrome 的调试端口 IPv4/IPv6 绑定不固定，两个都试）
    let wsUrl = null;
    for (let i = 0; i < 40 && !wsUrl; i++) {
      for (const host of ['[::1]', '127.0.0.1']) {
        try {
          const list = await (await fetch(`http://${host}:${port}/json/list`)).json();
          wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl;
        } catch { /* 未就绪 */ }
        if (wsUrl) break;
      }
      if (!wsUrl) await sleep(250);
    }
    if (!wsUrl) throw new Error('Chrome CDP 连接失败');

    const ws = new WebSocket(wsUrl);
    await new Promise(r => ws.onopen = r);
    let msgId = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Page.enable');
    await send('Page.navigate', { url: `${baseUrl}/?pdf=1#doc=${docId}` });
    // 等预览渲染完（app 在 pdf 模式渲染后置 title）
    const t0 = Date.now();
    let ready = false;
    while (Date.now() - t0 < 30000 && !ready) {
      await sleep(400);
      const r = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
      ready = r?.result?.value === 'PDF_READY';
    }
    if (!ready) throw new Error('预览渲染超时');
    const { data } = await send('Page.printToPDF', {
      preferCSSPageSize: true,
      printBackground: true,
      displayHeaderFooter: false,
    });
    ws.close();
    return Buffer.from(data, 'base64');
  } finally {
    chrome.kill();
  }
}
