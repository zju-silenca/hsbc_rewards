// 构建 dist/（Cloudflare 静态资源目录）：
//  - public/ 下的手写文件 + 派生文件（计算核心、ExcelJS、可安装的油猴脚本、version.json）
//  - CSS/JS 改名为带内容哈希的 assets/<名>.<哈希>.<扩展名>，HTML 里的引用同步替换；
//    这些文件长期缓存（见 _headers），HTML 每次协商（304），切换页面不再重新请求 CSS/JS
//  - 环境变量 SCRIPT_SRC 可指定供下载的油猴脚本（CI 用它取最新的 script-v* 标签）
//  - DEPLOY_ENV=dev 构建开发测试站：供下载的脚本改成独立的「dev」脚本（见 devScript）
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = (p) => resolve(root, 'public', p);
const out = (p) => resolve(root, 'dist', p);
const scriptVersion = (file) => (readFileSync(file, 'utf8').match(/^\/\/ @version\s+(\S+)/m) || [])[1] || null;

const PROD_HOST = 'hsbc-rewards.pi-app.kdns.fr';
const DEV_HOST = 'hsbc-rewards-dev.pi-app.kdns.fr';
const isDev = process.env.DEPLOY_ENV === 'dev';
const commit = (process.env.GITHUB_SHA || '').slice(0, 7) || null;

// 开发测试站提供的脚本：换成 dev 域名、独立的名字和命名空间（油猴里与正式版并存、存储分开），
// 版本号加上构建时间，每次部署 dev 后油猴都能检测到更新
function devScript(src) {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
  if (!src.includes(PROD_HOST)) throw new Error(`脚本里没有找到正式域名 ${PROD_HOST}，无法生成 dev 脚本`);
  return src
    .split(PROD_HOST).join(DEV_HOST)
    .replace(/^(\/\/ @name\s+.+)$/m, '$1 (dev)')
    .replace(/^(\/\/ @namespace\s+\S+)$/m, '$1-dev')
    .replace(/^(\/\/ @version\s+\S+)$/m, `$1.${stamp}`)
    .replace('<span>账单导出</span>', '<span>账单导出 dev</span>');
}

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
// 开发测试站不让搜索引擎收录
writeFileSync(out('_headers'), readFileSync(pub('_headers'), 'utf8') + (isDev ? '\n/*\n  X-Robots-Tag: noindex\n' : ''));
// 以 .user.js 结尾提供，油猴会识别并弹出安装/更新页（固定地址，不能加哈希）
const dist = readFileSync(distSrc, 'utf8');
writeFileSync(out('hsbc_bill_export.user.js'), isDev ? devScript(dist) : dist);

const version = {
  web: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version,
  core: scriptVersion(coreSrc),
  script: scriptVersion(out('hsbc_bill_export.user.js')),
  ...(isDev ? { env: 'dev' } : {}),
  ...(isDev && commit ? { commit } : {}), // dev 站直接部署 main 的提交
};
writeFileSync(out('version.json'), JSON.stringify(version, null, 2) + '\n');
console.log('built dist/:', version, `${Object.keys(map).length} 个哈希资源`);
