// CI 部署：上传新版本并 100% 切换过去，不改动路由/自定义域名
// （改自定义域名需要 Zone 级权限；域名绑定已存在且不变，CI Token 只需 Workers Editor）
import { execFileSync } from 'node:child_process';

const run = (args) => execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const msg = process.env.DEPLOY_MESSAGE || 'CI deploy';
const up = run(['versions', 'upload', '--message', msg]);
process.stdout.write(up);
const id = (up.match(/Worker Version ID:\s*([0-9a-f-]{36})/i) || [])[1];
if (!id) throw new Error('没能从 wrangler 输出里找到 Version ID');
process.stdout.write(run(['versions', 'deploy', `${id}@100%`, '--message', msg, '--yes']));
