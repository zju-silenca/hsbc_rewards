// CI 部署：上传新版本并 100% 切换过去，不改动路由/自定义域名
// （改自定义域名需要 Zone 级权限；域名绑定已存在且不变，CI Token 只需 Workers Editor）
import { execFileSync } from 'node:child_process';

const run = (args) => execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const msg = process.env.DEPLOY_MESSAGE || 'CI deploy';
const env = process.env.DEPLOY_ENV ? ['--env', process.env.DEPLOY_ENV] : []; // dev → 开发测试环境
const up = run(['versions', 'upload', ...env, '--message', msg]);
process.stdout.write(up);
const id = (up.match(/Worker Version ID:\s*([0-9a-f-]{36})/i) || [])[1];
if (!id) throw new Error('没能从 wrangler 输出里找到 Version ID');
// 刚上传的版本在 API 侧可能还没同步（code 100146：version could not be found），稍等重试
for (let i = 1; ; i++) {
  try {
    process.stdout.write(run(['versions', 'deploy', `${id}@100%`, ...env, '--message', msg, '--yes']));
    break;
  } catch (e) {
    if (i >= 5) throw e;
    console.log(`部署失败，${i * 5} 秒后重试（${i}/4）`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, i * 5000);
  }
}
