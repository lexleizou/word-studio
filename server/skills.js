// Skills：目录式技能（skills/<name>/SKILL.md，frontmatter 含 name/description）
// 启停状态存 sqlite；启用的技能列出 name+description 进 system prompt，AI 经 use_skill 取全文
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kvGet, kvSet } from './config-store.js';

const SKILLS_DIR = fileURLToPath(new URL('../data/skills', import.meta.url));

// 解析 frontmatter（--- name: xxx description: xxx ---），不引 yaml 依赖
function parseFrontmatter(content) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  const meta = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = /^([a-zA-Z_-]+):\s*(.+)$/.exec(line.trim());
      if (kv) meta[kv[1]] = kv[2].trim();
    }
  }
  return { meta, body: m ? content.slice(m[0].length) : content };
}

export async function scanSkills() {
  const enabled = await kvGet('skills_enabled', {});
  const skills = [];
  let entries = [];
  try { entries = await readdir(SKILLS_DIR, { withFileTypes: true }); } catch { return []; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const content = await readFile(join(SKILLS_DIR, e.name, 'SKILL.md'), 'utf8');
      const { meta } = parseFrontmatter(content);
      skills.push({
        name: meta.name || e.name,
        description: meta.description || '',
        enabled: enabled[meta.name || e.name] !== false, // 默认启用
      });
    } catch { /* 无 SKILL.md 的目录跳过 */ }
  }
  return skills;
}

export async function setSkillEnabled(name, isEnabled) {
  const enabled = await kvGet('skills_enabled', {});
  enabled[name] = !!isEnabled;
  await kvSet('skills_enabled', enabled);
}

export async function getSkillBody(name) {
  // 安全：只允许目录名形式的技能名
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return null;
  try {
    const content = await readFile(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    return parseFrontmatter(content).body.trim();
  } catch { return null; }
}

// 导入 .md：没有 frontmatter 就补一个
export async function importSkill(fileName, content) {
  const { meta } = parseFrontmatter(content);
  const name = (meta.name || fileName.replace(/\.md$/i, '')).replace(/[^a-zA-Z0-9_-]/g, '-');
  if (!name) throw new Error('无法确定技能名');
  const dir = join(SKILLS_DIR, name);
  await mkdir(dir, { recursive: true });
  if (!meta.name) content = `---\nname: ${name}\ndescription: ${meta.description || '（未填写描述）'}\n---\n\n` + content;
  await writeFile(join(dir, 'SKILL.md'), content);
  return { name };
}

// system prompt 用的启用技能清单
export async function enabledSkillsPrompt() {
  const skills = (await scanSkills()).filter(s => s.enabled);
  if (!skills.length) return '';
  return '\n\n可用技能（用 use_skill 工具取全文后按其指导操作）：\n' +
    skills.map(s => `- ${s.name}: ${s.description}`).join('\n');
}
