// 把油猴脚本（计算核心）和 ExcelJS 复制到 public/，保证网页和脚本用同一套算法
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(resolve(root, 'public/vendor'), { recursive: true });
copyFileSync(resolve(root, '../hsbc_bill_export.user.js'), resolve(root, 'public/core.js'));
// 同一份文件以 .user.js 结尾提供，油猴会识别并弹出安装/更新页
copyFileSync(resolve(root, '../hsbc_bill_export.user.js'), resolve(root, 'public/hsbc_bill_export.user.js'));
copyFileSync(resolve(root, 'node_modules/exceljs/dist/exceljs.min.js'), resolve(root, 'public/vendor/exceljs.min.js'));
console.log('synced core.js + hsbc_bill_export.user.js + vendor/exceljs.min.js');
