// 构建 dist/（Cloudflare 静态资源目录）：
//  - public/ 下的手写文件 + 派生文件（计算核心、ExcelJS、可安装的油猴脚本、version.json）
//  - CSS/JS 改名为带内容哈希的 assets/<名>.<哈希>.<扩展名>，HTML 里的引用同步替换；
//    这些文件长期缓存（见 _headers），HTML 每次协商（304），切换页面不再重新请求 CSS/JS
//  - 环境变量 SCRIPT_SRC 可指定供下载的油猴脚本（CI 用它取最新的 script-v* 标签）
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = (p) => resolve(root, 'public', p);
const out = (p) => resolve(root, 'dist', p);
const scriptVersion = (file) => (readFileSync(file, 'utf8').match(/^\/\/ @version\s+(\S+)/m) || [])[1] || null;

const coreSrc = resolve(root, '../hsbc_bill_export.user.js');
const distSrc = process.env.SCRIPT_SRC ? resolve(process.env.SCRIPT_SRC) : coreSrc;

rmSync(out(''), { recursive: true, force: true });
mkdirSync(out('assets'), { recursive: true });

// 1. 需要哈希的静态资源：HTML 中的引用路径 → 源文件
const assets = {
  'core.js': coreSrc, // 看板用的计算核心，跟随网站版本
  'vendor/exceljs.min.js': resolve(root, 'node_modules/exceljs/dist/exceljs.min.js'),
};
for (const f of readdirSync(pub(''))) if (/\.(css|js)$/.test(f)) assets[f] = pub(f);

const map = {};
for (const [ref, src] of Object.entries(assets)) {
  const buf = readFileSync(src);
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 10);
  const ext = extname(ref);
  const name = `assets/${basename(ref, ext)}.${hash}${ext}`;
  writeFileSync(out(name), buf);
  map[ref] = name;
}

// 2. HTML：替换引用，并检查没有遗漏的本地 CSS/JS 引用
for (const f of readdirSync(pub(''))) {
  if (!f.endsWith('.html')) continue;
  const html = readFileSync(pub(f), 'utf8').replace(/(\s(?:src|href)=")([^"]+)(")/g, (m, a, ref, b) => (map[ref] ? a + map[ref] + b : m));
  const left = [...html.matchAll(/\s(?:src|href)="([^":]+\.(?:css|js))"/g)].map((x) => x[1]).filter((r) => !r.startsWith('assets/') && !r.endsWith('.user.js'));
  if (left.length) throw new Error(`${f} 引用了未打包的文件：${left.join(', ')}`);
  writeFileSync(out(f), html);
}

// 3. 其他文件原样复制
copyFileSync(pub('_headers'), out('_headers'));
// 以 .user.js 结尾提供，油猴会识别并弹出安装/更新页（固定地址，不能加哈希）
copyFileSync(distSrc, out('hsbc_bill_export.user.js'));

const version = {
  web: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version,
  core: scriptVersion(coreSrc),
  script: scriptVersion(distSrc),
};
writeFileSync(out('version.json'), JSON.stringify(version, null, 2) + '\n');
console.log('built dist/:', version, `${Object.keys(map).length} 个哈希资源`);
