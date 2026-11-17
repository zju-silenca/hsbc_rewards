// 部署前准备 public/：
//  - core.js：看板用的计算核心（取自本次检出的油猴脚本，跟随网站版本）
//  - hsbc_bill_export.user.js：供安装/更新的油猴脚本（可用 SCRIPT_SRC 指定，跟随脚本版本）
//  - vendor/exceljs.min.js
//  - version.json：两边各自的版本号，便于核对线上部署
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = (p) => resolve(root, 'public', p);
const scriptVersion = (file) => (readFileSync(file, 'utf8').match(/^\/\/ @version\s+(\S+)/m) || [])[1] || null;

const coreSrc = resolve(root, '../hsbc_bill_export.user.js');
const distSrc = process.env.SCRIPT_SRC ? resolve(process.env.SCRIPT_SRC) : coreSrc;

mkdirSync(pub('vendor'), { recursive: true });
copyFileSync(coreSrc, pub('core.js'));
// 以 .user.js 结尾提供，油猴会识别并弹出安装/更新页
copyFileSync(distSrc, pub('hsbc_bill_export.user.js'));
copyFileSync(resolve(root, 'node_modules/exceljs/dist/exceljs.min.js'), pub('vendor/exceljs.min.js'));

const version = {
  web: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version,
  core: scriptVersion(coreSrc),
  script: scriptVersion(distSrc),
};
writeFileSync(pub('version.json'), JSON.stringify(version, null, 2) + '\n');
console.log('synced public/:', version);
