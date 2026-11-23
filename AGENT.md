# AGENT.md：修改与发版指南

本仓库包含两部分：
- 一个油猴脚本：在汇丰香港网银页面抓取信用卡交易，计算奖赏，并导出全公式 Excel。
- 一个纯前端的返利看板网站，托管在 Cloudflare Workers 静态资源上。

修改代码或发版前请读完本文。

## 目录结构

```
hsbc_bill_export.user.js     油猴脚本 = 计算核心（唯一的一份算法）
web/
  public/                    网站源文件（只放手写文件）
    index.html app.js        返利看板
    offers.html              优惠信息（施工中）
    app.css                  全站样式（含深色模式）
    theme.js                 非看板页的深浅色切换
    nav.js                   页面导航（手机在底部、电脑在顶部，下滑隐藏）
    _headers                 CSP、缓存等响应头
  scripts/build.mjs          构建 dist/（Cloudflare 实际上传的目录）
  scripts/deploy-ci.mjs      CI 部署（versions upload + deploy）
  wrangler.jsonc             Worker 配置（静态资源目录 dist/ + 自定义域名）
.github/workflows/deploy.yml 发布 Release 后自动部署
```

`web/dist/` 由 `npm run build` 生成，已加入 `.gitignore`，不要手改，也不要提交。构建会做这些事：
- 把 `public/` 下所有 CSS/JS、计算核心（根目录脚本）和 ExcelJS 改名为 `assets/<名>.<内容哈希>.<扩展名>`，并替换 HTML 里的引用。HTML 里新增本地 CSS/JS 时直接写源文件名即可；漏掉没打包的引用，构建会报错。
- 复制 HTML 和 `_headers`。
- 生成 `hsbc_bill_export.user.js`（供用户安装、更新的脚本，地址固定，不加哈希）和 `version.json`（线上版本号，CI 用它核对部署结果）。

## 必须遵守的约束

### 隐私
- **不要提交任何账单数据**：`.har`、`.xlsx`、`.csv` 及任何含交易记录、卡号、姓名的文件。`.gitignore` 已经排除了这些格式，新增导出格式时同步补上。
- **代码里不要硬编码个人信息**：卡号、发卡日、登记日、姓名、账号 ID 等都不行。个人设置一律走「参数」，看板存在本机 localStorage，脚本存在油猴存储。脚本要保持通用。
- **网站禁止任何网络请求**。`_headers` 里的 CSP 是 `connect-src 'none'`，账单只在浏览器本地处理。
  - 不要引入第三方脚本、CDN、统计或字体服务。
  - 第三方库通过 npm 安装，在 `build.mjs` 的 `assets` 里登记，打包进 `assets/`。
  - 页面里不要写内联脚本或内联样式，CSP 不允许。
- **脚本保存时只保留必要字段**：`slimTx` 会去掉完整卡号（只留后四位）和持卡人姓名。新增要保存的字段时，先确认它不含敏感信息。

### 计算核心只有一份
- 规则、渠道识别、退款匹配、Excel 生成都在 `hsbc_bill_export.user.js` 里，看板通过 `window.HSBCBillCore` 复用。不要在 `app.js` 里另写一套算法。
- 脚本被当作普通 `<script data-bill-core>` 加载时，只导出 `Core`，不运行油猴逻辑。
  - 判断依据是 `data-bill-core` 属性，**不要改用 `document.currentScript`**：油猴注入脚本时这个值同样存在，会误判。
- Node 里可以直接 `require('./hsbc_bill_export.user.js')` 拿到 `Core` 做测试。

### 按卡号计算
- 交易按卡号后四位（`Core.cardOf` / `Core.splitByCard`）分组。卡号相同就共用额度，附属卡也算在内。
- 每张卡单独 `normalize` 和计算。「全部」视图是把各卡的结果相加，**不能把所有交易混在一起只算一遍**。
- 看板的参数、实际到账按卡号分别保存在 `br:params-card`、`br:actual-card`。

### Excel
- 汇总全部用公式。单元格写成 `{ formula, result }`，同时带上 JS 算出的缓存值，打开文件不重算也能看到正确数字。
- `交易明细` 等表的列字母是固定的，代码在 `buildWorkbook` 里有断言（报错信息是「列错位」）。增删列时要同步改公式引用和断言。
- 参数表通过 `'参数'!$C$n` 绝对引用；增删参数要检查所有引用它的公式。
- 改了公式要验证：用 LibreOffice 无界面重算导出的文件，再和 JS 缓存值逐格对比，除 `TODAY()` 相关的单元格外应该完全一致。命令示例：

  ```sh
  soffice --headless --convert-to xlsx --outdir out/ in.xlsx
  ```

  对比可以用 openpyxl，分别以 `data_only=True` 读取重算前后的两个文件。

### 脚本与看板之间的通信
- 账单**不经过网址**传递：脚本同时运行在网银和看板两个站点上，数据存在油猴存储（`GM_*`）里，看板页通过同源 `postMessage` 取数据。
- 消息类型：
  - `br-request`：看板向脚本要数据。
  - `br-data`：脚本把数据交给看板。
  - `br-clear`：看板让脚本清空已保存的账单。
- 脚本在看板页就绪后会主动推送一次 `br-data`，看板也会持续请求约 30 秒。这是因为有的管理器（如 iOS 上的 Stay）以页面模式注入，就绪可能要好几秒，不能假设脚本先于页面就绪。
- **网站和脚本是分开发版的，用户装的脚本可能比网站旧，也可能更新**。改消息格式或存储结构（`bill-store-v1` / `bill-settings-v1`）时必须兼容旧版本。确实不兼容时，换一个新键名，并写迁移逻辑。
- 看板域名同时出现在脚本的三个地方，改域名时一起改：
  - `@match`
  - `CONFIG.VIEWER_URL`
  - `CONFIG.VIEWER_ORIGINS`

  另外 `@downloadURL` 和 `@updateURL` 也写着看板域名，它们决定油猴从哪里安装、更新脚本，改域名时同样要改。
  开发测试站的域名写在 `scripts/build.mjs`（`PROD_HOST` / `DEV_HOST`）和 `wrangler.jsonc` 的 `env.dev` 里，改正式域名时也要同步 `PROD_HOST`。

### 缓存
- `_headers` 让 `/assets/*` 永久缓存（`immutable`），其余文件（HTML、`.user.js`、`version.json`）都是 `no-cache`：每次向服务器确认，没变化就返回 304。
- 所以 CSS/JS 必须经过构建、带上哈希才能被引用。不要在 `assets/` 之外放需要长期缓存的文件，也不要给 HTML 加长缓存，否则发版后用户拿不到新页面。
- 静态资源请求在 Cloudflare 上免费、不限量，不占 Workers 请求额度。前提是不添加 Worker 脚本，也不配置 `run_worker_first`。

### 本地存储
- localStorage 只放便利性设置，比如参数、手动修改、主题。每次读写都要包在 try/catch 里，读不到时页面也要能正常显示。
- 改存储格式时写迁移逻辑，参考 `app.js` 的 `migrate()`：旧的 `br:params` / `br:actual` 会迁移成按卡号分组的结构。

## 本地开发

```sh
cd web
npm install
npm run dev        # build + wrangler dev，访问 http://localhost:8787（改了源文件要重新运行）
```

- **看板**：拖入 `.har` 或交易 JSON 即可看到数据，不需要油猴。
- **看板和脚本联调**：在浏览器里安装 `http://localhost:8787/hsbc_bill_export.user.js`，并临时给脚本加上 `@match http://localhost:8787/*`。`CONFIG.VIEWER_ORIGINS` 里已经包含 localhost。
- **开发测试站**：`https://hsbc-rewards-dev.pi-app.kdns.fr/`。`dev` 分支比 `main` 新，放还没发布的改动。push 到 `dev` 后 CI 自动部署开发测试站（网站和脚本都取这次提交），不影响正式站；合入 `main` 不会触发部署。
  - 在这里安装的是独立的 dev 脚本：名字带「(dev)」，命名空间不同，油猴里和正式版并存、存储分开；版本号后面带构建时间，每次部署后都能检查到更新。
  - dev 脚本同样运行在汇丰网银上，面板标题是「账单导出 dev」。和正式版同时启用会出现两个面板，测试时可以先停用正式版。
  - 开发测试站带 `X-Robots-Tag: noindex`。线上 `/version.json` 里的 `commit` 是部署的提交。
  - 这些都在 `scripts/build.mjs` 里用 `DEPLOY_ENV=dev` 生成，源码里不需要改动。
- **改完界面后自查**：
  - 浅色和深色都看一遍。
  - 手机宽度（390px）下没有横向滚动。
  - 控制台没有 CSP 报错或其他错误。

## 发版

网站和油猴脚本**分开管理版本**，各自打 Release 标签：

| 发布内容 | 先改版本号 | Release 标签 |
|---|---|---|
| 网站（`web/` 下的全部内容，包括看板使用的计算核心） | `web/package.json` 的 `version`，然后运行 `npm install --package-lock-only` 同步 lock 文件 | `web-vX.Y.Z` |
| 油猴脚本（供安装和更新的 `.user.js`） | 脚本头部的 `// @version` | `script-vX.Y.Z` |

### 步骤
1. 改代码，并按上面的约束自测。
2. 改对应的版本号，遵循语义化版本：修复改 Z，新功能改 Y，不兼容改动改 X。
3. 改动先进 `dev` 分支，在开发测试站上验证。没问题后开 PR 合入 `main`。`main` 禁止直接推送，只接受 PR，合并方式只能是 squash。
4. 发布 Release，例如：

   ```sh
   gh release create web-v1.2.0 --title "网站 1.2.0" --notes "- 变更说明"
   gh release create script-v4.3.0 --title "油猴脚本 4.3.0" --notes "- 变更说明"
   ```

5. 在 Actions 页面查看 **Deploy to Cloudflare** 的运行结果。它会依次：
   1. 取最新的 `web-v*` 标签部署网站，取最新的 `script-v*` 标签作为供下载的脚本。本次发布的是哪一边，就用本次的标签。
   2. 核对标签与文件里的版本号，不一致时直接失败。
   3. 运行 `npm run deploy:ci`，即 `wrangler versions upload` 再加 `versions deploy`。这一步不改动自定义域名。
   4. 读取线上的 `/version.json`，确认两边的版本都已更新。

### 注意
- **计算规则改了，两边通常都要发版**：看板的计算核心跟着网站版本走，只发脚本版本的话，看板还在用旧算法。
- **油猴只在 `@version` 变大时提示更新**。改了脚本就一定要调大版本号。
- **CI 使用仓库密钥**：`CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`，放在 Repository secrets 里。Token 只需要 Workers 的编辑权限。
- **改自定义域名或路由时**，由维护者在本地用已登录的 wrangler 运行 `npm run deploy`（开发测试站用 `npm run deploy:dev`），这个命令会同步域名配置。CI 不处理域名。
- **手动重新部署**：在 Actions 页面点 Run workflow，两边都会取各自最新的标签。
