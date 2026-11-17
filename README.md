# HSBC 信用卡账单导出 + 返利看板

- `hsbc_bill_export.user.js`：油猴脚本，同时也是计算核心。
  - 在汇丰网银捕获、拉取信用卡交易，累计保存在油猴存储里。
  - 一键导出全公式 Excel。
  - 在看板网站上把账单交给页面（postMessage，不经过网址和服务器）。
- `web/`：Cloudflare Worker 静态站点（纯前端，CSP 禁止一切网络请求），按卡号展示消费与返利。

## 安装脚本

打开 <https://bill.pi-app.kdns.fr/hsbc_bill_export.user.js>，Tampermonkey 会弹出安装页。

## 开发与部署

```sh
cd web
npm install
npm run dev      # 本地 http://localhost:8787
npm run deploy   # 先 sync（复制脚本与 ExcelJS 到 public/），再 wrangler deploy
```

账单数据（`.har`、`.xlsx`）已在 `.gitignore` 中排除，不要提交。
