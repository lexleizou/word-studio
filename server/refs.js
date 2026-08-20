// @ 引用文件：上传 / 文本提取 / 清单
// 提取能力：docx 走 unzip+剥标签，pdf 走 pdftotext（poppler），txt/md 直读，图片走 base64（多模态）
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomBytes } from 'node:crypto';

const run = promisify(execFile);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

const refsDir = (dir) => join(dir, 'refs');
const refsMeta = (dir) => join(dir, 'refs', 'refs.json');

async function loadMeta(dir) {
  try { return JSON.parse(await readFile(refsMeta(dir), 'utf8')); } catch { return []; }
}

async function saveMeta(dir, list) {
  await mkdir(refsDir(dir), { recursive: true });
  await writeFile(refsMeta(dir), JSON.stringify(list, null, 2));
}

export async function listRefs(dir) {
  const list = await loadMeta(dir);
  return list.map(({ text, ...meta }) => meta); // 清单不带正文
}

export async function getRef(dir, id) {
  const list = await loadMeta(dir);
  return list.find(r => r.id === id) || null;
}

async function unzipText(docxPath, entry) {
  try {
    const { stdout } = await run('unzip', ['-p', docxPath, entry], { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' });
    return Buffer.from(stdout).toString('utf8');
  } catch { return null; }
}

// 提取文本内容（图片返回 null，走 base64）
export async function extractText(filePath, ext) {
  ext = ext.toLowerCase();
  if (IMAGE_EXTS.has(ext)) return null;
  if (['.txt', '.md', '.markdown', '.csv', '.json', '.log'].includes(ext)) {
    return (await readFile(filePath, 'utf8')).slice(0, 20000);
  }
  if (ext === '.docx' || ext === '.doc') {
    const xml = await unzipText(filePath, 'word/document.xml');
    if (!xml) throw new Error('docx 解析失败（.doc 请先转成 .docx）');
    // 段落换行保留，其余标签剥掉
    return xml
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 20000);
  }
  if (ext === '.pdf') {
    try {
      const { stdout } = await run('pdftotext', ['-layout', filePath, '-'], { maxBuffer: 16 * 1024 * 1024 });
      return stdout.trim().slice(0, 20000);
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error('PDF 提取需要 poppler（brew install poppler）');
      throw err;
    }
  }
  throw new Error(`不支持的文件类型 ${ext}`);
}

// 上传并提取
export async function addRef(dir, filename, content) {
  const id = 'f' + Date.now().toString(36) + randomBytes(2).toString('hex');
  const ext = extname(filename).toLowerCase();
  await mkdir(refsDir(dir), { recursive: true });
  const storedName = `${id}${ext}`;
  const filePath = join(refsDir(dir), storedName);
  await writeFile(filePath, content);
  const isImage = IMAGE_EXTS.has(ext);
  let text = null;
  try { text = await extractText(filePath, ext); } catch (err) { text = `（提取失败: ${err.message}）`; }
  const list = await loadMeta(dir);
  const meta = { id, name: filename, storedName, ext, isImage, chars: text?.length || 0, addedAt: new Date().toISOString() };
  list.push({ ...meta, text });
  await saveMeta(dir, list);
  return meta;
}

// 拼对话附件块（文本注入上下文，图片转 base64 data-url）
export async function buildAttachment(dir, refId) {
  const ref = await getRef(dir, refId);
  if (!ref) return null;
  if (ref.isImage) {
    const buf = await readFile(join(refsDir(dir), ref.storedName));
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ref.ext] || 'image/png';
    return { type: 'image', name: ref.name, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  }
  return { type: 'text', name: ref.name, text: ref.text || '' };
}

// import_file 工具用：读提取文本
export async function refText(dir, refId) {
  const ref = await getRef(dir, refId);
  return ref?.isImage ? null : (ref?.text ?? null);
}
