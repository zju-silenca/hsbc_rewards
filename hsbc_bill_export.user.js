// ==UserScript==
// @name         HSBC 信用卡账单导出 + Pulse 返利计算
// @namespace    hsbc-bill-export
// @version      4.2.1
// @description  在汇丰网银页面捕获/拉取信用卡交易记录，累计保存并在在线看板查看，一键导出 Excel（全公式：基础奖赏0.4%、Pulse特别奖赏2%、赏世界2%、内地餐饮3%、迎新礼、按入账日对账）
// @match        https://www.hsbc.com.hk/*
// @run-at       document-start
// @match        https://bill.pi-app.kdns.fr/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @require      https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js
// @downloadURL  https://bill.pi-app.kdns.fr/hsbc_bill_export.user.js
// @updateURL    https://bill.pi-app.kdns.fr/hsbc_bill_export.user.js
// ==/UserScript==

/* eslint-disable no-console */
(function () {
  'use strict';

  // ============================================================
  // 配置（这里是导出时写进 Excel「参数」表的默认值；导出后也可以直接在 Excel 参数表里改，全表自动重算）
  // 发卡日 / 最红登记日也可在网页右下角面板里填
  // ============================================================
  const CONFIG = {
    // ---- ① 基础「奖赏钱」：所有合资格签账 0.4% ----
    BASE_RATE: 0.004,

    // ---- ② Pulse 特别奖赏 2%：云闪付 QR / Apple Pay / Google Pay / Samsung Pay，限内地及澳门（2026 下半年签账额度 80,000）----
    MOBILE: {
      RATE: 0.02,
      CHANNELS: ['QR', 'APPLEPAY', 'GOOGLEPAY', 'SAMSUNGPAY'],
      REGIONS: 'CN,MO', // 商户国家/地区代码
      START: '2026-07-01',
      END: '2026-12-31',
      CAP: 80000, // 合资格签账额度
    },

    // ---- ③ 赏世界 2%：香港以外签账（年度签账额度 100,000，最多 $2,000）----
    WORLD: {
      ENABLED: true, // 是否已登记赏世界
      RATE: 0.02,
      START: '2026-01-01',
      END: '2026-12-31',
      REG_DATE: '', // 登记日（之前的签账不计）；留空 = 全年都算
      CAP: 100000,
      RC_CAP: 2000,
    },

    // 不计任何返利的 MCC（还款、取现、准现金）
    EXCLUDED_MCC: ['0000', '6010', '6011', '6051'],
    // 默认「计返利 = 否」的 MCC（导出后可在明细表手动改回「是」）
    // 4111 公共交通：公交卡/市民卡充值属于储值卡充值，实测不给返利（注意地铁乘车也是 4111）
    DEFAULT_NO_MCC: ['4111'],

    // ---- ④ 内地餐饮 3%（2026 最红签账奖赏 – 中国内地，条款 Y26-U8-CAMH0307）----
    // 每历月内地合资格签账净额 ≥ 1200，当月合资格餐饮签账额外 3%，每月上限 $80，向上取整；完成后两个月内统一志入
    REDHOT: {
      START: '2026-07-01',
      END: '2026-12-31',
      THRESHOLD: 1200,
      RATE: 0.03,
      CAP_PER_MONTH: 80,
      REG_DATE: '', // Reward+ 登记日（登记前签账不计）；留空 = 视为推广开始前已登记
      DINING_MCC: ['5812', '5813', '5814'], // 餐厅食肆；条款排除酒席宴会，所以不含 5811
    },

    // ---- ⑤ 迎新礼（条款 Y26-U8-CMAS0107）----
    // 发卡后首 60 个历日内累积合资格签账满 8000 → 800 RC；填写邀请码的，另外每笔 Reward+/云闪付 二维码 ≥ 50 → +10 RC，最多 28 次
    WELCOME: {
      CARD_ISSUE_DATE: '', // 发卡日；留空 = 按最早一笔交易日估算
      DAYS: 60,
      THRESHOLD: 8000,
      QR_MIN: 50,
      QR_REWARD: 10,
      QR_MAX_TIMES: 28,
      BASE_REWARD: 800, // 满门槛的迎新奖赏
      INVITE: true, // 是否填写了邀请码（QR 每笔奖赏的前提）
    },

    // 仅作提示（不影响计算）
    RISK_RULES: [
      { re: /TENCENT|TENPAY|ALIPAY|WECHAT|ZHIFUBAO|CAIFUTONG/i, tip: '微信/支付宝相关商户' },
      { re: /CAIZHENG|SHUIWU|TAX|GOVERNMENT|ZHENGFU/i, tip: '政府/缴税类商户' },
    ],

    // 月份 / 账单周期 / 各推广期按哪个日期归属：'post' = 入账日（RC 按入账日结算），'txn' = 交易日
    PERIOD_BY: 'post',
    STATEMENT_DAY: 7, // 账单日（捕获到账户详情时自动使用真实账单日）

    // 在线看板：脚本同时运行在看板页面，从油猴存储读取账单交给页面（不经过网址和服务器）
    // 改地址时同步修改顶部的 @match
    VIEWER_URL: 'https://bill.pi-app.kdns.fr/',
    VIEWER_ORIGINS: ['https://bill.pi-app.kdns.fr', 'http://localhost:8787'],
  };

  // ============================================================
  // MCC 商户类型表
  // ============================================================
  const MCC_NAMES = {
    '0000': '还款/非消费',
    '3998': '银联自定义码（未公开，非餐饮）',
    '4111': '公共交通（地铁/公交）',
    '4112': '铁路客运',
    '4121': '出租车/网约车',
    '4131': '长途客运',
    '4411': '邮轮',
    '4511': '航空公司',
    '4722': '旅行社/OTA',
    '4784': '路桥通行费',
    '4789': '交通运输服务',
    '4812': '电信设备/手机',
    '4814': '电信服务/话费充值',
    '4816': '网络/信息服务',
    '4899': '有线电视/流媒体订阅',
    '4900': '公用事业（水电燃气）',
    '5045': '电脑及外设',
    '5111': '文具办公用品',
    '5122': '药品',
    '5200': '家居建材',
    '5300': '会员制批发店',
    '5309': '免税店',
    '5310': '折扣商店',
    '5311': '百货商场',
    '5331': '杂货店/便利店',
    '5399': '综合零售/电商平台',
    '5411': '超市/生鲜',
    '5422': '肉类/冷冻食品',
    '5441': '糖果/零食',
    '5451': '乳制品',
    '5462': '面包/糕点店',
    '5499': '食品专卖/便利店',
    '5541': '加油站',
    '5542': '自助加油',
    '5611': '男装',
    '5621': '女装',
    '5651': '服装（家庭）',
    '5655': '运动服饰',
    '5661': '鞋店',
    '5691': '服装店',
    '5699': '服饰配件',
    '5712': '家具',
    '5719': '家居用品',
    '5722': '家用电器',
    '5732': '电子产品',
    '5733': '乐器',
    '5734': '软件',
    '5735': '音像制品',
    '5811': '宴会/包办餐饮（最红餐饮不计）',
    '5812': '餐饮 - 餐厅',
    '5813': '餐饮 - 酒吧/饮品店',
    '5814': '餐饮 - 快餐/外卖',
    '5912': '药店',
    '5921': '酒类专卖',
    '5931': '二手/寄卖商店',
    '5940': '自行车',
    '5941': '体育用品',
    '5942': '书店',
    '5943': '文具店',
    '5945': '玩具/游戏',
    '5947': '礼品/纪念品',
    '5948': '箱包皮具',
    '5970': '工艺美术品',
    '5977': '化妆品',
    '5992': '花店',
    '5993': '烟草',
    '5994': '报刊亭',
    '5995': '宠物用品',
    '5998': '帐篷/遮阳用品（银联常见于停车/管理服务）',
    '5999': '其他专门零售',
    '6010': '柜台取现',
    '6011': 'ATM 取现',
    '6012': '金融机构',
    '6051': '准现金/充值',
    '6300': '保险',
    '6513': '房地产租赁/物业',
    '7011': '酒店住宿',
    '7210': '洗衣服务',
    '7230': '美容美发',
    '7298': 'SPA/美容',
    '7311': '广告服务',
    '7372': '软件/信息技术服务',
    '7399': '商业服务',
    '7512': '汽车租赁/网约车',
    '7523': '停车场',
    '7538': '汽车维修',
    '7832': '电影院',
    '7841': '影音租赁',
    '7922': '演出票务',
    '7941': '体育赛事/俱乐部',
    '7991': '旅游景点',
    '7994': '游戏厅/电子游戏',
    '7996': '游乐园',
    '7997': '会所/健身房',
    '7999': '其他娱乐服务（含微信/腾讯等）',
    '8011': '诊所/医生',
    '8021': '牙科',
    '8062': '医院',
    '8099': '医疗服务',
    '8211': '中小学',
    '8220': '大学',
    '8241': '函授学校',
    '8299': '教育培训',
    '8398': '慈善/社会服务',
    '8999': '专业服务',
    '9211': '法院费用',
    '9222': '罚款',
    '9311': '缴税',
    '9399': '政府服务',
    '9402': '邮政服务',
  };

  function mccName(mcc) {
    if (!mcc) return '未知';
    return MCC_NAMES[mcc] || `其他（MCC ${mcc}）`;
  }

  // ============================================================
  // 工具函数
  // ============================================================
  const CHANNEL_RULES = [
    [/^QR\b/i, 'QR'],
    [/^APPLEPAY\b/i, 'APPLEPAY'],
    [/^GOOGLE ?PAY\b/i, 'GOOGLEPAY'],
    [/^SAMSUNG ?PAY\b/i, 'SAMSUNGPAY'],
    [/^SALES:/i, 'SALES'],
    [/^RETURN:/i, 'RETURN'],
    [/^PAYMENT/i, 'PAYMENT'],
  ];

  function detectChannel(desc) {
    const d = (desc || '').trim();
    for (const [re, ch] of CHANNEL_RULES) if (re.test(d)) return ch;
    return 'OTHER';
  }

  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  /** 模拟 Excel ROUND（四舍五入、远离零） */
  const xround = (x, d = 2) => { const m = 10 ** d; return Math.sign(x) * Math.round(Math.abs(x) * m + 1e-7) / m; };
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
  const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
  /** 'YYYY-MM-DD' → Excel 日期（UTC 零点，避免时区偏移） */
  const xdate = (s) => { if (!s) return null; const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };

  function fmtTime(t) {
    if (!t || t.length < 4) return '';
    const s = t.padStart(6, '0');
    return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
  }

  function txKey(t) {
    return [t.uniqueTransactionIdentifier, t.transactionDate, t.realTimeTransactionDetails?.transactionTime,
      t.authorizationCode, t.transactionAmount?.amount, (t.transactionDescriptions || []).join('|'),
      t.transactionCreditDebitCode].join('#');
  }

  /** 卡号后四位：按卡号区分账单，卡号相同（含附属卡）共用返利额度 */
  function cardOf(t) {
    return String(t.cardNumberDisplay || t.cardNumber || '').slice(-4) || '????';
  }
  /** 按卡号分组，笔数多的在前 */
  function splitByCard(txs) {
    const m = new Map();
    for (const t of txs) {
      const c = cardOf(t);
      if (!m.has(c)) m.set(c, []);
      m.get(c).push(t);
    }
    return new Map([...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])));
  }

  function dedupe(txs) {
    const m = new Map();
    for (const t of txs) m.set(txKey(t), t);
    return [...m.values()];
  }

  /** 账单日：日期 ≤ 账单日 → 当月账单日，否则下月账单日（与 Excel 公式一致） */
  function stmtDateOf(s, sd) {
    const [y, m, d] = s.split('-').map(Number);
    return ymd(d <= sd ? new Date(y, m - 1, sd) : new Date(y, m, sd));
  }

  // ============================================================
  // 参数（写入 Excel「参数」表，所有公式引用这里）
  // ============================================================
  function buildParams(cfg, opts, rows) {
    const issue = opts.cardIssueDate || cfg.WELCOME.CARD_ISSUE_DATE || (rows.find((r) => !r.isCredit)?.date || '');
    const issueEstimated = !(opts.cardIssueDate || cfg.WELCOME.CARD_ISSUE_DATE);
    const M = cfg.MOBILE, W = cfg.WORLD, R = cfg.REDHOT, WL = cfg.WELCOME;
    const list = [
      ['§', '通用'],
      ['PERIOD_BY', '归属日期', cfg.PERIOD_BY === 'txn' ? '交易日' : '入账日', null, '入账日 / 交易日。月份、账单周期、各推广期按此日期归属；未入账交易自动按交易日'],
      ['STMT_DAY', '账单日（每月几号）', opts.statementDay || cfg.STATEMENT_DAY, '0'],
      ['§', '① 基础奖赏（所有消费）'],
      ['BASE_RATE', '基础返利率', cfg.BASE_RATE, '0.0%', '所有合资格签账'],
      ['§', '② Pulse 特别奖赏（云闪付 QR / Apple·Google·Samsung Pay，限内地及澳门）'],
      ['MOB_RATE', '额外返利率', M.RATE, '0.0%'],
      ['MOB_REGIONS', '适用地区代码', M.REGIONS, null, '商户国家/地区代码，逗号分隔'],
      ['MOB_START', '计算开始', xdate(M.START), 'yyyy-mm-dd'],
      ['MOB_END', '计算结束', xdate(M.END), 'yyyy-mm-dd'],
      ['MOB_CAP', '签账额度', M.CAP, '#,##0', '超出部分不再给额外返利'],
      ['§', '③ 赏世界（香港以外）'],
      ['WORLD_ON', '已登记赏世界', W.ENABLED ? '是' : '否', null, '是 / 否'],
      ['WORLD_RATE', '额外返利率', W.RATE, '0.0%', '香港以外签账（所有支付方式）'],
      ['WORLD_START', '计算开始', xdate(W.START), 'yyyy-mm-dd'],
      ['WORLD_END', '计算结束', xdate(W.END), 'yyyy-mm-dd'],
      ['WORLD_REG', '登记日', xdate(W.REG_DATE), 'yyyy-mm-dd', '留空 = 不限制；填写后，该日期前的交易不计'],
      ['WORLD_CAP', '年度签账额度', W.CAP, '#,##0'],
      ['WORLD_RC_CAP', '年度奖赏钱上限', W.RC_CAP, '#,##0'],
      ['§', '④ 内地餐饮（当月内地签账满门槛才有，推广后审核到账）'],
      ['RH_START', '推广开始', xdate(R.START), 'yyyy-mm-dd'],
      ['RH_END', '推广结束', xdate(R.END), 'yyyy-mm-dd'],
      ['RH_REG', 'Reward+ 登记日', xdate(opts.redhotRegDate || R.REG_DATE), 'yyyy-mm-dd', '留空 = 视为已提前登记；登记前签账不计'],
      ['RH_THR', '每历月内地签账门槛', R.THRESHOLD, '#,##0', '所有类别内地合资格签账'],
      ['RH_RATE', '餐饮额外返利率', R.RATE, '0.0%'],
      ['RH_CAP', '每月上限', R.CAP_PER_MONTH, '#,##0', '每月额外奖赏钱向上取整'],
      ['§', '⑤ 迎新礼（达标后审核到账）'],
      ['W_ISSUE', '发卡日', xdate(issue), 'yyyy-mm-dd', issueEstimated ? '⚠ 未填写，按最早一笔交易日估算，请改成真实发卡日' : ''],
      ['W_DAYS', '计算天数', WL.DAYS, '0', '发卡日算第 1 天'],
      ['W_THR', '累积签账门槛', WL.THRESHOLD, '#,##0'],
      ['W_QR_MIN', 'QR 单笔最低', WL.QR_MIN, '#,##0'],
      ['W_QR_RC', '每笔奖赏钱', WL.QR_REWARD, '#,##0'],
      ['W_QR_MAX', '最多次数', WL.QR_MAX_TIMES, '0'],
      ['W_BASE_RC', '满门槛迎新奖赏', WL.BASE_REWARD, '#,##0'],
      ['W_INVITE', '已填写邀请码', WL.INVITE ? '是' : '否', null, '是 / 否：填了邀请码才有 QR 每笔奖赏'],
    ];
    const values = {};
    for (const [k, , v] of list) if (k !== '§') values[k] = v instanceof Date ? v.toISOString().slice(0, 10) : (v ?? '');
    return { list, values, issueEstimated };
  }

  // ============================================================
  // 整理交易（只做「事实」层面的处理：渠道识别、退款匹配、是否计返利）
  // ============================================================
  function normalize(txs, cfg = CONFIG, opts = {}) {
    const rows = dedupe(txs).map((t) => {
      const rt = t.realTimeTransactionDetails || {};
      const desc = (t.transactionDescriptions || []).join(' ').replace(/\s+/g, ' ').trim();
      const isCredit = t.transactionCreditDebitCode === 'CREDIT_TRANSACTION';
      const amt = Number(t.transactionAmount?.amount || 0);
      const mcc = t.merchantCategoryCode || '';
      const card = t.cardNumberDisplay || t.cardNumber || '';
      const channel = detectChannel(desc);
      return {
        id: [t.transactionDate, rt.transactionTime, t.authorizationCode, t.transactionAmount?.amount, t.transactionCreditDebitCode, desc].join('|'),
        date: t.transactionDate || '',
        time: fmtTime(rt.transactionTime),
        postDate: t.transactionPostingDate || '',
        card4: card.slice(-4),
        // 未入账(PENDING)交易的附属卡标志不可靠，只对已入账交易判断
        supp: t.transactionStatus !== 'PENDING' && t.secondaryCardTransactionIndicator === true ? '附属卡' : '主卡',
        desc,
        channel,
        calcCh: channel,
        merchant: rt.merchantName || '',
        city: rt.merchantCity || '',
        country: rt.merchantCountryCode || '',
        amount: isCredit ? -amt : amt,
        absAmount: amt,
        currency: t.transactionAmount?.currencyCode || '',
        isCredit,
        authCode: t.authorizationCode || '',
        mcc,
        mccName: mccName(mcc),
        dining: cfg.REDHOT.DINING_MCC.includes(mcc) ? '是' : '',
        billed: t.transactionType === 'BILLED' ? '已出账单' : (t.transactionType === 'UNBILLED' ? '未出账单' : (t.transactionType || '')),
        status: t.transactionStatus === 'PENDING' ? '处理中' : (t.transactionStatus === 'HISTORIC' ? '已入账' : (t.transactionStatus || '')),
        authType: rt.authorizationType || '',
        arn: t.acquirerReferenceNumber || '',
        refundAmt: 0,
        notes: [],
        risk: cfg.RISK_RULES.filter((x) => x.re.test(desc)).map((x) => x.tip),
      };
    });

    rows.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time) || (a.isCredit - b.isCredit));

    // 是否计返利（消费）
    for (const r of rows) {
      r.isSpend = !r.isCredit && r.channel !== 'PAYMENT' && !cfg.EXCLUDED_MCC.includes(r.mcc);
      r.elig = r.isSpend ? '是' : '否';
      if (!r.isCredit && r.channel !== 'PAYMENT' && !r.isSpend) r.notes.push('MCC 不计返利');
      if (r.isSpend && (cfg.DEFAULT_NO_MCC || []).includes(r.mcc)) {
        r.elig = '否';
        r.notes.push(`MCC ${r.mcc} 默认不计返利（如实际有返利可改为「是」）`);
      }
      if (r.status === '处理中') r.notes.push('处理中，入账后才计入');
    }

    // 退款匹配：同卡 + 同授权码。退款行继承原消费的渠道/地区，返利按负数扣回（在退款入账日）
    for (const r of rows.filter((x) => x.isCredit && x.channel !== 'PAYMENT')) {
      const orig = rows.find((o) => !o.isCredit && o.authCode && o.authCode === r.authCode && o.card4 === r.card4
        && round2(o.absAmount - o.refundAmt) >= r.absAmount - 0.001);
      if (orig) {
        orig.refundAmt = round2(orig.refundAmt + r.absAmount);
        const full = Math.abs(orig.refundAmt - orig.absAmount) < 0.005;
        orig.notes.push(full ? `已全额退款（${r.date}）` : `部分退款 ${r.absAmount}（${r.date}）`);
        r.notes.push(`冲减 ${orig.date} ${orig.channel} 消费 ${orig.absAmount}`);
        r.calcCh = orig.channel;
        r.refundOfId = orig.id;
        r.country = r.country || orig.country;
        r.elig = orig.elig;
      } else {
        r.notes.push('未匹配到原消费，不冲减');
      }
    }

    rows.cfg = cfg;
    rows.opts = opts;
    rows.params = buildParams(cfg, opts, rows);
    computeModel(rows);
    return rows;
  }

  // ============================================================
  // 计算模型：与 Excel 公式逐一对应，用于写入公式的缓存结果（不支持重算的查看器也能显示正确数值）
  // ============================================================
  function computeModel(rows) {
    const p = rows.params.values;
    const cfg = rows.cfg;
    const regions = `,${p.MOB_REGIONS},`;
    const wEnd = p.W_ISSUE ? addDays(p.W_ISSUE, p.W_DAYS - 1) : '';
    for (const r of rows) {
      const yes = r.elig === '是';
      r.eff = (p.PERIOD_BY === '入账日' && r.postDate) ? r.postDate : r.date;
      r.month = r.eff.slice(0, 7);
      r.stmt = stmtDateOf(r.eff, p.STMT_DAY);
      r.net = r.amount > 0 ? r.amount - r.refundAmt : 0;
      r.baseAmt = yes ? r.amount : 0;
      r.baseRC = xround(r.baseAmt * p.BASE_RATE);
      const inMob = yes && cfg.MOBILE.CHANNELS.includes(r.calcCh) && r.country && regions.toUpperCase().includes(`,${r.country.toUpperCase()},`)
        && r.eff >= p.MOB_START && r.eff <= p.MOB_END;
      r.mobAmt = inMob ? r.amount : 0;
      r.mobRC = xround(r.mobAmt * p.MOB_RATE);
      const inWorld = yes && p.WORLD_ON === '是' && r.country !== 'HK' && r.eff >= p.WORLD_START && r.eff <= p.WORLD_END
        && (!p.WORLD_REG || r.date >= p.WORLD_REG);
      r.worldAmt = inWorld ? r.amount : 0;
      r.worldRC = xround(r.worldAmt * p.WORLD_RATE);
      r.rcTotal = r.baseRC + r.mobRC + r.worldRC;
      const inRh = yes && r.country === 'CN' && r.eff >= p.RH_START && r.eff <= p.RH_END && (!p.RH_REG || r.date >= p.RH_REG);
      r.rhAmt = inRh ? r.amount : 0;
      r.rhDining = r.dining === '是' ? r.rhAmt : 0;
      const inWel = yes && r.supp !== '附属卡' && !!p.W_ISSUE && r.date >= p.W_ISSUE && r.date <= wEnd;
      r.welAmt = inWel ? r.amount : 0;
      r.welQR = (r.welAmt > 0 && r.calcCh === 'QR' && r.net >= p.W_QR_MIN) ? 1 : 0;
    }
    let n = 0;
    for (const r of rows) if (r.welQR) r.welQRIdx = ++n;
    rows.wEnd = wEnd;
  }

  /**
   * 应用手动修改（计返利 / 餐饮），退款行跟随原消费，然后重算
   * overrides = { elig: { [id]: '是'|'否' }, dining: { [id]: '是'|'' } }
   */
  function applyOverrides(rows, overrides = {}) {
    const elig = overrides.elig || {}, dining = overrides.dining || {};
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of rows) {
      if (r.id in dining) r.dining = dining[r.id];
      if (r.id in elig && !r.isCredit) r.elig = elig[r.id];
    }
    for (const r of rows) {
      if (r.refundOfId && byId.has(r.refundOfId)) {
        const o = byId.get(r.refundOfId);
        r.elig = r.id in elig ? elig[r.id] : o.elig;
        if (!(r.id in dining)) r.dining = o.dining;
      }
    }
    computeModel(rows);
    return rows;
  }

  /** 精简交易数据（去掉完整卡号、持卡人姓名等，用于传给在线看板） */
  function slimTx(t) {
    const rt = t.realTimeTransactionDetails || {};
    const card = t.cardNumberDisplay || t.cardNumber || '';
    return {
      transactionDate: t.transactionDate, transactionPostingDate: t.transactionPostingDate, transactionType: t.transactionType,
      transactionStatus: t.transactionStatus, transactionAmount: t.transactionAmount, transactionDescriptions: t.transactionDescriptions,
      cardNumberDisplay: card.slice(-4), secondaryCardTransactionIndicator: t.secondaryCardTransactionIndicator,
      merchantCategoryCode: t.merchantCategoryCode, transactionCreditDebitCode: t.transactionCreditDebitCode,
      authorizationCode: t.authorizationCode, acquirerReferenceNumber: t.acquirerReferenceNumber,
      uniqueTransactionIdentifier: t.uniqueTransactionIdentifier ? String(t.uniqueTransactionIdentifier).slice(-24) : undefined,
      realTimeTransactionDetails: {
        transactionTime: rt.transactionTime, merchantName: rt.merchantName, merchantCity: rt.merchantCity,
        merchantCountryCode: rt.merchantCountryCode, authorizationType: rt.authorizationType,
      },
    };
  }

  /**
   * 累计保存：按卡号分别处理，新数据覆盖的日期范围内以新数据为准（处理中→已入账不会重复），更早的旧数据保留
   */
  function mergeStore(stored, fresh) {
    const card = cardOf;
    const minDate = new Map();
    for (const t of fresh) {
      const c = card(t), d = t.transactionDate || '';
      if (d && (!minDate.has(c) || d < minDate.get(c))) minDate.set(c, d);
    }
    const kept = stored.filter((t) => !minDate.has(card(t)) || (t.transactionDate || '') < minDate.get(card(t)));
    return dedupe(kept.concat(fresh)).sort((a, b) => (b.transactionDate || '').localeCompare(a.transactionDate || ''));
  }

  /** 从 HAR 文本中提取交易与账单日 */
  function parseHar(text) {
    const har = JSON.parse(text);
    let txs = [], statementDay = null;
    for (const e of har.log?.entries || []) {
      const url = e.request?.url || '';
      const c = e.response?.content;
      if (!c?.text) continue;
      const isTx = /\/v2\/transactions\?/.test(url), isAcct = /\/accounts\/credit-cards\//.test(url);
      if (!isTx && !isAcct) continue;
      const raw = c.encoding === 'base64' ? new TextDecoder().decode(Uint8Array.from(atob(c.text), (ch) => ch.charCodeAt(0))) : c.text;
      const d = JSON.parse(raw);
      if (isTx && Array.isArray(d.transactions)) txs = txs.concat(d.transactions);
      const sd = d?.creditCardAccountDetail?.lastStatementCycle?.statementDate;
      if (isAcct && sd) statementDay = Number(sd.slice(8, 10));
    }
    return { txs: dedupe(txs), statementDay };
  }

  // ============================================================
  // Excel 生成（ExcelJS）—— 全部汇总用公式
  // ============================================================
  const FILL = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
  const COLORS = {
    hInput: 'FF1F4E78', hFormula: 'FF375623', hEdit: 'FFC65911',
    qr: 'FFFF9999', apple: 'FF99E699', dining: 'FFFFF2CC', edit: 'FFFFF2CC',
    credit: 'FFDDEBF7', total: 'FFFCE4D6', ok: 'FFC6EFCE', no: 'FFFFC7CE', section: 'FFD9E1F2', grey: 'FF999999',
  };
  const MONEY = '#,##0.00';
  const DATE = 'yyyy-mm-dd';
  const PCT = '0.00%';
  const F = (formula, result) => ({ formula, result });
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);

  function styleHeader(row, colorOf) {
    row.eachCell((c, i) => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = FILL((colorOf && colorOf(i)) || COLORS.hInput);
      c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    row.height = 34;
  }

  /** 交易明细列定义：kind = input（数据）/ edit（可手改）/ formula（公式） */
  function detailColumns(cfg) {
    const mobOr = cfg.MOBILE.CHANNELS.map((c) => `$K{n}="${c}"`).join(',');
    return [
      { key: 'date', h: '交易日期', w: 11, fmt: DATE, v: (r) => xdate(r.date) },
      { key: 'time', h: '交易时间', w: 9, v: (r) => r.time },
      { key: 'post', h: '入账日期', w: 11, fmt: DATE, v: (r) => (r.postDate ? xdate(r.postDate) : '未入账') },
      { key: 'eff', h: '归属日期', w: 11, fmt: DATE, kind: 'formula', f: 'IF(AND({PERIOD_BY}="入账日",ISNUMBER($C{n})),$C{n},$A{n})', res: (r) => xdate(r.eff) },
      { key: 'month', h: '归属月份', w: 9, kind: 'formula', f: 'YEAR($D{n})&"-"&TEXT(MONTH($D{n}),"00")', res: (r) => r.month },
      { key: 'stmt', h: '所属账单日', w: 11, fmt: DATE, kind: 'formula', f: 'IF(DAY($D{n})<={STMT_DAY},DATE(YEAR($D{n}),MONTH($D{n}),{STMT_DAY}),DATE(YEAR($D{n}),MONTH($D{n})+1,{STMT_DAY}))', res: (r) => xdate(r.stmt) },
      { key: 'card4', h: '卡号后四位', w: 8, v: (r) => r.card4 },
      { key: 'supp', h: '主/附属卡', w: 8, v: (r) => r.supp },
      { key: 'desc', h: '交易详情', w: 42, v: (r) => r.desc },
      { key: 'ch', h: '支付渠道', w: 10, v: (r) => r.channel },
      { key: 'calcCh', h: '计算渠道', w: 10, v: (r) => r.calcCh, note: '退款行继承原消费渠道' },
      { key: 'merchant', h: '商户名称', w: 24, v: (r) => r.merchant },
      { key: 'city', h: '商户城市', w: 10, v: (r) => r.city },
      { key: 'country', h: '国家/地区', w: 8, v: (r) => r.country },
      { key: 'amount', h: '金额', w: 11, fmt: MONEY, v: (r) => r.amount },
      { key: 'currency', h: '币种', w: 6, v: (r) => r.currency },
      { key: 'auth', h: '授权码', w: 8, v: (r) => r.authCode },
      { key: 'mcc', h: 'MCC', w: 6, v: (r) => r.mcc },
      { key: 'mccName', h: '商户类型', w: 22, v: (r) => r.mccName },
      { key: 'dining', h: '餐饮', w: 6, kind: 'edit', v: (r) => r.dining },
      { key: 'billed', h: '账单状态', w: 9, v: (r) => r.billed },
      { key: 'status', h: '交易状态', w: 8, v: (r) => r.status },
      { key: 'refund', h: '已退款金额', w: 10, fmt: MONEY, v: (r) => r.refundAmt || null },
      { key: 'net', h: '净额', w: 10, fmt: MONEY, kind: 'formula', f: 'IF($O{n}>0,$O{n}-N($W{n}),0)', res: (r) => r.net },
      { key: 'elig', h: '计返利', w: 7, kind: 'edit', v: (r) => r.elig },
      { key: 'baseAmt', h: '①基础 合资格额', w: 11, fmt: MONEY, kind: 'formula', f: 'IF($Y{n}="是",$O{n},0)', res: (r) => r.baseAmt },
      { key: 'baseRC', h: '①基础RC', w: 9, fmt: MONEY, kind: 'formula', f: 'ROUND($Z{n}*{BASE_RATE},2)', res: (r) => r.baseRC },
      { key: 'mobAmt', h: '②Pulse特别 合资格额', w: 11, fmt: MONEY, kind: 'formula',
        f: `IF(AND($Y{n}="是",OR(${mobOr}),ISNUMBER(SEARCH(","&$N{n}&",",","&{MOB_REGIONS}&",")),$D{n}>={MOB_START},$D{n}<={MOB_END}),$O{n},0)`, res: (r) => r.mobAmt },
      { key: 'mobRC', h: '②Pulse特别 RC', w: 9, fmt: MONEY, kind: 'formula', f: 'ROUND($AB{n}*{MOB_RATE},2)', res: (r) => r.mobRC },
      { key: 'worldAmt', h: '③赏世界 合资格额', w: 11, fmt: MONEY, kind: 'formula',
        f: 'IF(AND($Y{n}="是",{WORLD_ON}="是",$N{n}<>"HK",$D{n}>={WORLD_START},$D{n}<={WORLD_END},OR({WORLD_REG}="",$A{n}>={WORLD_REG})),$O{n},0)', res: (r) => r.worldAmt },
      { key: 'worldRC', h: '③赏世界RC', w: 9, fmt: MONEY, kind: 'formula', f: 'ROUND($AD{n}*{WORLD_RATE},2)', res: (r) => r.worldRC },
      { key: 'rcTotal', h: '①+②+③ RC', w: 9, fmt: MONEY, kind: 'formula', f: '$AA{n}+$AC{n}+$AE{n}', res: (r) => r.rcTotal },
      { key: 'rhAmt', h: '④内地签账', w: 11, fmt: MONEY, kind: 'formula',
        f: 'IF(AND($Y{n}="是",$N{n}="CN",$D{n}>={RH_START},$D{n}<={RH_END},OR({RH_REG}="",$A{n}>={RH_REG})),$O{n},0)', res: (r) => r.rhAmt },
      { key: 'rhDining', h: '④内地餐饮', w: 10, fmt: MONEY, kind: 'formula', f: 'IF($T{n}="是",$AG{n},0)', res: (r) => r.rhDining },
      { key: 'welAmt', h: '⑤迎新 签账', w: 10, fmt: MONEY, kind: 'formula',
        f: 'IF(AND($Y{n}="是",$H{n}<>"附属卡",$A{n}>={W_ISSUE},$A{n}<={W_ISSUE}+{W_DAYS}-1),$O{n},0)', res: (r) => r.welAmt },
      { key: 'welQR', h: '⑤迎新 QR≥50', w: 9, kind: 'formula', f: 'IF(AND($AI{n}>0,$K{n}="QR",$X{n}>={W_QR_MIN}),1,0)', res: (r) => r.welQR },
      { key: 'risk', h: '提示', w: 18, v: (r) => r.risk.join('；') },
      { key: 'note', h: '备注', w: 32, v: (r) => r.notes.join('；') },
      { key: 'authType', h: '授权类型', w: 13, v: (r) => r.authType },
      { key: 'arn', h: '收单参考号', w: 25, v: (r) => r.arn },
    ];
  }

  async function buildWorkbook(ExcelJSLib, rows, cfg = CONFIG, meta = {}) {
    const noCache = !!meta.noCache; // 测试用：不写缓存结果，让 Excel/LibreOffice 自己算
    const FX = (formula, result) => (noCache ? { formula } : F(formula, result));
    const today = meta.today || ymd(new Date());
    const P = rows.params;
    const pv = P.values;

    const wb = new ExcelJSLib.Workbook();
    wb.creator = 'hsbc-bill-export';
    wb.created = new Date();
    wb.calcProperties = { fullCalcOnLoad: true };

    // 先按顺序建表（Tab 顺序），再填内容
    const S = {
      ov: wb.addWorksheet('返利总览'),
      dt: wb.addWorksheet('交易明细', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] }),
      mo: wb.addWorksheet('按月汇总', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] }),
      rc: wb.addWorksheet('按入账日对账', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] }),
      cy: wb.addWorksheet('按账单周期', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] }),
      wl: wb.addWorksheet('Pulse迎新进度'),
      mc: wb.addWorksheet('商户类型统计', { views: [{ state: 'frozen', ySplit: 1 }] }),
      pa: wb.addWorksheet('参数'),
      ns: wb.addWorksheet('说明'),
    };

    // ---------------- 参数 ----------------
    const pref = {};
    S.pa.columns = [{ key: 'k', width: 14 }, { key: 'l', width: 24 }, { key: 'v', width: 16 }, { key: 'n', width: 70 }];
    styleHeader(S.pa.addRow(['参数名', '说明', '值（可修改）', '备注']));
    for (const [k, label, v, fmt, note] of P.list) {
      if (k === '§') {
        const r = S.pa.addRow(['', label]);
        r.eachCell((c) => { c.font = { bold: true }; c.fill = FILL(COLORS.section); });
        r.getCell(3).fill = FILL(COLORS.section); r.getCell(4).fill = FILL(COLORS.section);
        continue;
      }
      const r = S.pa.addRow([k, label, v ?? null, note || '']);
      const c = r.getCell(3);
      c.fill = FILL(COLORS.edit);
      c.alignment = { horizontal: 'right' };
      if (fmt) c.numFmt = fmt;
      if (k === 'PERIOD_BY') c.dataValidation = { type: 'list', allowBlank: false, formulae: ['"入账日,交易日"'] };
      if (k === 'WORLD_ON' || k === 'W_INVITE') c.dataValidation = { type: 'list', allowBlank: false, formulae: ['"是,否"'] };
      if (k === 'W_ISSUE' && P.issueEstimated) r.getCell(4).font = { color: { argb: 'FFC00000' }, bold: true };
      pref[k] = `'参数'!$C$${r.number}`;
    }
    S.pa.addRow([]);
    S.pa.addRow(['', '黄色格子可以直接修改，交易明细和所有汇总表会自动重算。']);
    const sub = (tpl, n) => tpl.replace(/\{n\}/g, n).replace(/\{([A-Z_]+)\}/g, (m, k) => pref[k] || m);

    // ---------------- 交易明细 ----------------
    const cols = detailColumns(cfg);
    S.dt.columns = cols.map((c) => ({ key: c.key, width: c.w, style: c.fmt ? { numFmt: c.fmt } : {} }));
    S.dt.addRow(cols.map((c) => c.h));
    styleHeader(S.dt.getRow(1), (i) => {
      const k = cols[i - 1].kind;
      return k === 'formula' ? COLORS.hFormula : (k === 'edit' ? COLORS.hEdit : COLORS.hInput);
    });
    const L = {};
    cols.forEach((c, i) => { L[c.key] = S.dt.getColumn(i + 1).letter; });
    // 校验：公式里写死的列字母与实际列一致
    const expect = { A: 'date', C: 'post', D: 'eff', H: 'supp', K: 'calcCh', N: 'country', O: 'amount', T: 'dining', W: 'refund', X: 'net', Y: 'elig', Z: 'baseAmt', AB: 'mobAmt', AD: 'worldAmt', AA: 'baseRC', AC: 'mobRC', AE: 'worldRC', AG: 'rhAmt', AI: 'welAmt' };
    for (const [letter, key] of Object.entries(expect)) if (L[key] !== letter) throw new Error(`列错位：${key} 应在 ${letter}，实际 ${L[key]}`);

    const first = 2, last = rows.length + 1;
    rows.forEach((r, i) => {
      const n = i + 2;
      const row = S.dt.getRow(n);
      cols.forEach((c, j) => {
        const cell = row.getCell(j + 1);
        if (c.kind === 'formula') cell.value = FX(sub(c.f, n), c.res(r));
        else cell.value = c.v(r);
        if (c.kind === 'edit') cell.dataValidation = { type: 'list', allowBlank: true, formulae: ['"是,否"'] };
      });
      const g = (k) => row.getCell(cols.findIndex((c) => c.key === k) + 1);
      if (r.channel === 'QR') g('desc').fill = FILL(COLORS.qr);
      else if (r.channel === 'APPLEPAY') g('desc').fill = FILL(COLORS.apple);
      if (r.dining === '是') g('mccName').fill = FILL(COLORS.dining);
      if (r.isCredit) { g('amount').font = { color: { argb: 'FF2E75B6' }, bold: true }; g('amount').fill = FILL(COLORS.credit); }
      if (!r.postDate) g('post').font = { color: { argb: COLORS.grey }, italic: true };
      if (r.refundAmt > 0) g('note').font = { color: { argb: 'FFC00000' } };
    });
    S.dt.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    const R = (key) => `'交易明细'!$${L[key]}$${first}:$${L[key]}$${last}`;
    const tot = rows.length ? S.dt.addRow([]) : null;
    if (tot) {
      tot.getCell(1).value = '合计';
      for (const k of ['amount', 'net', 'baseAmt', 'baseRC', 'mobAmt', 'mobRC', 'worldAmt', 'worldRC', 'rcTotal', 'rhAmt', 'rhDining', 'welAmt', 'welQR']) {
        const c = tot.getCell(L[k]);
        c.value = FX(`SUM(${L[k]}${first}:${L[k]}${last})`, sum(rows.map((r) => r[k === 'amount' ? 'amount' : k])));
        c.numFmt = k === 'welQR' ? '0' : MONEY;
      }
      tot.eachCell((c) => { c.font = { bold: true }; c.fill = FILL(COLORS.total); });
    }

    // ---------------- 按月汇总 ----------------
    const months = [...new Set(rows.map((r) => r.month))].sort();
    const by = (pred) => rows.filter(pred);
    const sumF = (list, k) => sum(list.map((r) => r[k]));
    const RH = { thr: pv.RH_THR, rate: pv.RH_RATE, cap: pv.RH_CAP };
    const moCols = [
      ['month', '归属月份', 10], ['spend', '合资格签账', 12, MONEY], ['qr', 'QR', 11, MONEY], ['ap', 'APPLEPAY', 11, MONEY], ['sales', 'SALES', 11, MONEY],
      ['baseRC', '①基础RC', 10, MONEY], ['mobAmt', '②Pulse特别 合资格', 12, MONEY], ['mobRC', '②Pulse特别 RC', 10, MONEY],
      ['worldAmt', '③赏世界 合资格', 12, MONEY], ['worldRC', '③赏世界RC', 10, MONEY], ['sub', '①+②+③ RC', 11, MONEY],
      ['rh', '④内地签账', 12, MONEY], ['reach', '是否达标', 10], ['gap', '距达标还差', 11, MONEY], ['dining', '④合资格餐饮', 11, MONEY],
      ['bonus', '④内地餐饮RC（审核后到账）', 13, '#,##0'], ['potential', '达标后可得', 10, '#,##0'], ['toCap', '餐饮再刷多少封顶', 12, MONEY],
      ['total', '当月预计RC', 11, MONEY], ['refunds', '退款', 10, MONEY],
    ];
    S.mo.columns = moCols.map(([key, , w, fmt]) => ({ key, width: w, style: fmt ? { numFmt: fmt } : {} }));
    S.mo.addRow(moCols.map((c) => c[1]));
    styleHeader(S.mo.getRow(1));
    const ML = {}; moCols.forEach(([k], i) => { ML[k] = S.mo.getColumn(i + 1).letter; });
    const moRow = {};
    const moVals = {};
    months.forEach((m, i) => {
      const n = i + 2; moRow[m] = n;
      const list = by((r) => r.month === m);
      const key = `$A${n}`;
      const SI = (k, extra = '') => `SUMIFS(${R(k)},${R('month')},${key}${extra})`;
      const spend = sumF(list, 'baseAmt');
      const rh = sumF(list, 'rhAmt');
      const dining = sumF(list, 'rhDining');
      const potential = Math.ceil(Math.min(dining * RH.rate, RH.cap) - 1e-9);
      const reach = rh >= RH.thr;
      const sub3 = sumF(list, 'baseRC') + sumF(list, 'mobRC') + sumF(list, 'worldRC');
      moVals[m] = { rh, gap: Math.max(0, RH.thr - rh), reach: reach ? '✔ 已达标' : '✘ 未达标', dining, bonus: reach ? potential : 0, potential, toCap: Math.max(0, RH.cap / RH.rate - dining) };
      const v = {
        month: m,
        spend: FX(SI('baseAmt'), spend),
        qr: FX(SI('baseAmt', `,${R('calcCh')},"QR"`), sumF(list.filter((r) => r.calcCh === 'QR'), 'baseAmt')),
        ap: FX(SI('baseAmt', `,${R('calcCh')},"APPLEPAY"`), sumF(list.filter((r) => r.calcCh === 'APPLEPAY'), 'baseAmt')),
        sales: FX(SI('baseAmt', `,${R('calcCh')},"SALES"`), sumF(list.filter((r) => r.calcCh === 'SALES'), 'baseAmt')),
        baseRC: FX(SI('baseRC'), sumF(list, 'baseRC')),
        mobAmt: FX(SI('mobAmt'), sumF(list, 'mobAmt')),
        mobRC: FX(SI('mobRC'), sumF(list, 'mobRC')),
        worldAmt: FX(SI('worldAmt'), sumF(list, 'worldAmt')),
        worldRC: FX(SI('worldRC'), sumF(list, 'worldRC')),
        sub: FX(`${ML.baseRC}${n}+${ML.mobRC}${n}+${ML.worldRC}${n}`, sub3),
        rh: FX(SI('rhAmt'), rh),
        reach: FX(`IF(${ML.rh}${n}>=${pref.RH_THR},"✔ 已达标","✘ 未达标")`, reach ? '✔ 已达标' : '✘ 未达标'),
        gap: FX(`MAX(0,${pref.RH_THR}-${ML.rh}${n})`, Math.max(0, RH.thr - rh)),
        dining: FX(SI('rhDining'), dining),
        bonus: FX(`IF(${ML.rh}${n}>=${pref.RH_THR},${ML.potential}${n},0)`, reach ? potential : 0),
        potential: FX(`ROUNDUP(MIN(${ML.dining}${n}*${pref.RH_RATE},${pref.RH_CAP}),0)`, potential),
        toCap: FX(`MAX(0,${pref.RH_CAP}/${pref.RH_RATE}-${ML.dining}${n})`, Math.max(0, RH.cap / RH.rate - dining)),
        total: FX(`${ML.sub}${n}+${ML.bonus}${n}`, sub3 + (reach ? potential : 0)),
        refunds: FX(`-SUMIFS(${R('amount')},${R('month')},${key},${R('ch')},"RETURN")`, -sumF(list.filter((r) => r.channel === 'RETURN'), 'amount')),
      };
      const row = S.mo.addRow(v);
      row.getCell('reach').fill = FILL(reach ? COLORS.ok : COLORS.no);
      row.getCell('total').font = { bold: true };
    });
    const moLast = months.length + 1, moTot = months.length + 2;
    {
      const row = S.mo.getRow(moTot);
      row.getCell(1).value = '合计';
      moCols.forEach(([k], i) => {
        if (['month', 'reach', 'gap', 'potential', 'toCap'].includes(k)) return;
        const col = ML[k];
        const res = sum(months.map((m) => S.mo.getCell(`${col}${moRow[m]}`).value?.result ?? 0));
        row.getCell(i + 1).value = FX(`SUM(${col}2:${col}${moLast})`, res);
      });
      row.eachCell((c) => { c.font = { bold: true }; c.fill = FILL(COLORS.total); });
    }
    S.mo.addRow([]);
    S.mo.addRow(['说明：①②③ 为逐笔计算、额度封顶在「返利总览」中处理；④ 按历月判断，内地签账满门槛后当月餐饮 ×3%，每月上限后向上取整，推广结束后统一志入。']);

    // ---------------- 按入账日对账 ----------------
    const postKeys = [...new Set(rows.filter((r) => r.channel !== 'PAYMENT').map((r) => r.postDate || '未入账'))]
      .sort((a, b) => (a === '未入账') - (b === '未入账') || a.localeCompare(b));
    const rcCols = [
      ['post', '入账日期', 12, DATE], ['stmt', '所属账单日', 12, DATE], ['n', '笔数', 6, '0'], ['spend', '消费', 11, MONEY], ['refund', '退款', 10, MONEY],
      ['baseRC', '①基础RC', 10, MONEY], ['mobRC', '②Pulse特别 RC', 12, MONEY], ['worldRC', '③赏世界RC', 11, MONEY], ['day', '当日应得RC', 11, MONEY],
      ['actual', '实际到账RC（手填）', 13, MONEY], ['diff', '差额', 10, MONEY],
      ['dining', '④内地餐饮签账（仅显示，不计当日）', 15, MONEY], ['wq', '⑤迎新 QR≥50 笔数（仅显示）', 12, '0'], ['txd', '包含的交易日期', 22],
    ];
    S.rc.columns = rcCols.map(([key, , w, fmt]) => ({ key, width: w, style: fmt ? { numFmt: fmt } : {} }));
    S.rc.addRow(rcCols.map((c) => c[1]));
    styleHeader(S.rc.getRow(1), (i) => (rcCols[i - 1][0] === 'actual' ? COLORS.hEdit : (['dining', 'wq'].includes(rcCols[i - 1][0]) ? 'FF7F7F7F' : COLORS.hInput)));
    const RL = {}; rcCols.forEach(([k], i) => { RL[k] = S.rc.getColumn(i + 1).letter; });
    postKeys.forEach((k, i) => {
      const n = i + 2;
      const list = by((r) => r.channel !== 'PAYMENT' && (r.postDate || '未入账') === k);
      const key = `$A${n}`;
      const SI = (col, extra = '') => `SUMIFS(${R(col)},${R('post')},${key}${extra})`;
      const day = sumF(list, 'baseRC') + sumF(list, 'mobRC') + sumF(list, 'worldRC');
      const row = S.rc.addRow({
        post: k === '未入账' ? k : xdate(k),
        stmt: k === '未入账' ? null : xdate(stmtDateOf(k, pv.STMT_DAY)),
        n: FX(`COUNTIFS(${R('post')},${key},${R('ch')},"<>PAYMENT")`, list.length),
        spend: FX(SI('amount', `,${R('amount')},">0"`), sumF(list.filter((r) => r.amount > 0), 'amount')),
        refund: FX(`-${SI('amount', `,${R('ch')},"RETURN"`)}`, -sumF(list.filter((r) => r.channel === 'RETURN'), 'amount')),
        baseRC: FX(SI('baseRC'), sumF(list, 'baseRC')),
        mobRC: FX(SI('mobRC'), sumF(list, 'mobRC')),
        worldRC: FX(SI('worldRC'), sumF(list, 'worldRC')),
        day: FX(`${RL.baseRC}${n}+${RL.mobRC}${n}+${RL.worldRC}${n}`, day),
        actual: null,
        diff: FX(`IF(${RL.actual}${n}="","",${RL.actual}${n}-${RL.day}${n})`, ''),
        dining: FX(SI('rhDining'), sumF(list, 'rhDining')),
        wq: FX(SI('welQR'), sumF(list, 'welQR')),
        txd: [...new Set(list.map((r) => r.date.slice(5)))].join(', '),
      });
      row.getCell('actual').fill = FILL(COLORS.edit);
      row.getCell('day').font = { bold: true };
      for (const c of ['dining', 'wq']) row.getCell(c).font = { color: { argb: COLORS.grey } };
      if (k === '未入账') row.eachCell((c) => { c.font = { color: { argb: COLORS.grey }, italic: true }; });
    });
    {
      const n = postKeys.length + 2, lastR = postKeys.length + 1;
      const row = S.rc.getRow(n);
      row.getCell(1).value = '合计';
      for (const k of ['n', 'spend', 'refund', 'baseRC', 'mobRC', 'worldRC', 'day', 'actual', 'dining', 'wq']) {
        const col = RL[k];
        const res = sum(postKeys.map((_, i) => S.rc.getCell(`${col}${i + 2}`).value?.result ?? 0));
        row.getCell(col).value = FX(`SUM(${col}2:${col}${lastR})`, res);
      }
      row.getCell('diff').value = FX(`IF(${RL.actual}${n}=0,"",${RL.actual}${n}-${RL.day}${n})`, '');
      row.eachCell((c) => { c.font = { bold: true }; c.fill = FILL(COLORS.total); });
    }
    S.rc.addRow([]);
    S.rc.addRow(['说明：消费在其入账日按全额计 RC，退款在退款入账日按负数扣回；①②③ 按逐笔四舍五入到分估算，额度封顶未在逐日中体现。④ 内地餐饮与 ⑤ 迎新礼达标后审核、统一志入，不计入当日应得 RC。']);

    // ---------------- 按账单周期 ----------------
    const stmts = [...new Set(rows.map((r) => r.stmt))].sort();
    const cyCols = [
      ['stmt', '账单日', 12, DATE], ['range', '周期', 23], ['spend', '合资格签账', 12, MONEY], ['qr', 'QR', 11, MONEY], ['ap', 'APPLEPAY', 11, MONEY], ['sales', 'SALES', 11, MONEY],
      ['baseRC', '①基础RC', 10, MONEY], ['mobRC', '②Pulse特别 RC', 10, MONEY], ['worldRC', '③赏世界RC', 10, MONEY], ['sub', '①+②+③ RC', 11, MONEY], ['refunds', '退款', 10, MONEY],
    ];
    S.cy.columns = cyCols.map(([key, , w, fmt]) => ({ key, width: w, style: fmt ? { numFmt: fmt } : {} }));
    S.cy.addRow(cyCols.map((c) => c[1]));
    styleHeader(S.cy.getRow(1));
    const CL = {}; cyCols.forEach(([k], i) => { CL[k] = S.cy.getColumn(i + 1).letter; });
    stmts.forEach((s, i) => {
      const n = i + 2;
      const list = by((r) => r.stmt === s);
      const key = `$A${n}`;
      const SI = (k, extra = '') => `SUMIFS(${R(k)},${R('stmt')},${key}${extra})`;
      const prev = new Date(parseYmd(s)); prev.setMonth(prev.getMonth() - 1); prev.setDate(prev.getDate() + 1);
      S.cy.addRow({
        stmt: xdate(s),
        range: `${ymd(prev)} ~ ${s}`,
        spend: FX(SI('baseAmt'), sumF(list, 'baseAmt')),
        qr: FX(SI('baseAmt', `,${R('calcCh')},"QR"`), sumF(list.filter((r) => r.calcCh === 'QR'), 'baseAmt')),
        ap: FX(SI('baseAmt', `,${R('calcCh')},"APPLEPAY"`), sumF(list.filter((r) => r.calcCh === 'APPLEPAY'), 'baseAmt')),
        sales: FX(SI('baseAmt', `,${R('calcCh')},"SALES"`), sumF(list.filter((r) => r.calcCh === 'SALES'), 'baseAmt')),
        baseRC: FX(SI('baseRC'), sumF(list, 'baseRC')),
        mobRC: FX(SI('mobRC'), sumF(list, 'mobRC')),
        worldRC: FX(SI('worldRC'), sumF(list, 'worldRC')),
        sub: FX(`${CL.baseRC}${n}+${CL.mobRC}${n}+${CL.worldRC}${n}`, sumF(list, 'baseRC') + sumF(list, 'mobRC') + sumF(list, 'worldRC')),
        refunds: FX(`-SUMIFS(${R('amount')},${R('stmt')},${key},${R('ch')},"RETURN")`, -sumF(list.filter((r) => r.channel === 'RETURN'), 'amount')),
      });
    });
    {
      const n = stmts.length + 2, lastR = stmts.length + 1;
      const row = S.cy.getRow(n);
      row.getCell(1).value = '合计';
      for (const k of ['spend', 'qr', 'ap', 'sales', 'baseRC', 'mobRC', 'worldRC', 'sub', 'refunds']) {
        const col = CL[k];
        row.getCell(col).value = FX(`SUM(${col}2:${col}${lastR})`, sum(stmts.map((_, i) => S.cy.getCell(`${col}${i + 2}`).value?.result ?? 0)));
      }
      row.eachCell((c) => { c.font = { bold: true }; c.fill = FILL(COLORS.total); });
    }
    S.cy.addRow([]);
    S.cy.addRow(['说明：账单日由「归属日期」和参数表的账单日推算；未入账交易归到预计的账单。']);

    // ---------------- Pulse 迎新进度 ----------------
    const wSpend = sumF(rows, 'welAmt');
    const wPend = sumF(rows.filter((r) => r.status === '处理中'), 'welAmt');
    const wCount = sumF(rows, 'welQR');
    const wTimes = Math.min(wCount, pv.W_QR_MAX);
    const wReached = wSpend >= pv.W_THR;
    const wQrRC = pv.W_INVITE === '是' ? wTimes * pv.W_QR_RC : 0;
    S.wl.columns = [{ width: 30 }, { width: 18 }, { width: 12 }, { width: 44 }, { width: 8 }, { width: 10 }];
    const WC = {};
    const wkv = [
      ['issue', '发卡日', FX(pref.W_ISSUE, xdate(pv.W_ISSUE)), DATE],
      ['end', '窗口截止日', FX(`${pref.W_ISSUE}+${pref.W_DAYS}-1`, xdate(rows.wEnd)), DATE],
      ['left', '剩余天数（含今天）', FX('MAX(0,B3-TODAY()+1)', rows.wEnd ? Math.max(0, daysBetween(today, rows.wEnd) + 1) : 0), '0'],
      ['spend', '累积合资格签账', FX(`SUM(${R('welAmt')})`, wSpend), MONEY],
      ['pend', '其中未入账', FX(`SUMIFS(${R('welAmt')},${R('status')},"处理中")`, wPend), MONEY],
      ['gap', '距门槛还差', FX(`MAX(0,${pref.W_THR}-B5)`, Math.max(0, pv.W_THR - wSpend)), MONEY],
      ['reach', '是否已满门槛', FX(`IF(B5>=${pref.W_THR},"✔ 已满","✘ 未满")`, wReached ? '✔ 已满' : '✘ 未满')],
      ['count', 'QR 单笔达标笔数', FX(`SUM(${R('welQR')})`, wCount), '0'],
      ['times', '计入次数', FX(`MIN(B9,${pref.W_QR_MAX})`, wTimes), '0'],
      ['remain', '还可再获次数', FX(`${pref.W_QR_MAX}-B10`, pv.W_QR_MAX - wTimes), '0'],
      ['potential', 'QR 每笔奖赏（需邀请码）', FX(`IF(${pref.W_INVITE}="是",B10*${pref.W_QR_RC},0)`, wQrRC), '#,##0'],
      ['base', '满门槛迎新奖赏', FX(pref.W_BASE_RC, pv.W_BASE_RC), '#,##0'],
      ['reward', '当前预计可得', FX(`IF(B5>=${pref.W_THR},B13+B12,0)`, wReached ? pv.W_BASE_RC + wQrRC : 0), '#,##0'],
    ];
    const hw = S.wl.addRow(['⑤ 迎新礼', '']);
    hw.eachCell((c) => { c.font = { bold: true, size: 13 }; c.fill = FILL(COLORS.section); });
    hw.getCell(2).fill = FILL(COLORS.section);
    wkv.forEach(([k, label, val, fmt]) => {
      const r = S.wl.addRow([label, val]);
      r.getCell(1).font = { bold: true };
      if (fmt) r.getCell(2).numFmt = fmt;
      WC[k] = `'Pulse迎新进度'!$B$${r.number}`;
    });
    if (WC.end !== "'Pulse迎新进度'!$B$3" || WC.spend !== "'Pulse迎新进度'!$B$5" || WC.potential !== "'Pulse迎新进度'!$B$12" || WC.reward !== "'Pulse迎新进度'!$B$14") throw new Error('迎新表行号错位');
    S.wl.getCell('B14').font = { bold: true };
    S.wl.addRow(['规则', '发卡后首 N 个历日内累积签账满门槛 → 迎新奖赏；填写邀请码的，窗口内每笔 Reward+/云闪付 二维码 ≥ 最低额另加 +10（最多 28 次）。附属卡不计；退款冲减；达标后审核到账。']);
    S.wl.addRow([]);
    styleHeader(S.wl.addRow(['序号', '交易日期', '净额', '交易详情', 'MCC', '状态']));
    for (const r of rows.filter((x) => x.welQR)) {
      const row = S.wl.addRow([r.welQRIdx, xdate(r.date), r.net, r.desc, r.mcc, r.status]);
      row.getCell(2).numFmt = DATE; row.getCell(3).numFmt = MONEY;
      row.getCell(4).fill = FILL(COLORS.qr);
      if (r.welQRIdx > pv.W_QR_MAX) row.getCell(1).fill = FILL(COLORS.no);
    }

    // ---------------- 商户类型统计 ----------------
    S.mc.columns = [{ key: 'mcc', width: 8 }, { key: 'name', width: 30 }, { key: 'dining', width: 8 }, { key: 'count', width: 7, style: { numFmt: '0' } },
      { key: 'amount', width: 12, style: { numFmt: MONEY } }, { key: 'net', width: 12, style: { numFmt: MONEY } }, { key: 'rc', width: 11, style: { numFmt: MONEY } }, { key: 'merchants', width: 70 }];
    S.mc.addRow(['MCC', '商户类型', '餐饮', '笔数', '消费金额', '扣除退款后', '①+②+③ RC', '涉及商户']);
    styleHeader(S.mc.getRow(1));
    const mccs = [...new Set(rows.filter((r) => !r.isCredit).map((r) => r.mcc))];
    const mstat = mccs.map((m) => {
      const list = rows.filter((r) => r.mcc === m);
      return { m, list, net: sumF(list.filter((r) => !r.isCredit), 'net') };
    }).sort((a, b) => b.net - a.net);
    mstat.forEach(({ m, list }, i) => {
      const n = i + 2;
      const debit = list.filter((r) => !r.isCredit);
      const row = S.mc.addRow({
        mcc: m, name: mccName(m), dining: cfg.REDHOT.DINING_MCC.includes(m) ? '是' : '',
        count: FX(`COUNTIFS(${R('mcc')},$A${n},${R('amount')},">0")`, debit.length),
        amount: FX(`SUMIFS(${R('amount')},${R('mcc')},$A${n},${R('amount')},">0")`, sumF(debit, 'amount')),
        net: FX(`SUMIFS(${R('net')},${R('mcc')},$A${n})`, sumF(debit, 'net')),
        rc: FX(`SUMIFS(${R('rcTotal')},${R('mcc')},$A${n})`, sumF(list, 'rcTotal')),
        merchants: [...new Set(debit.map((r) => r.merchant).filter(Boolean))].join(', '),
      });
      row.getCell('mcc').numFmt = '@';
      if (cfg.REDHOT.DINING_MCC.includes(m)) row.eachCell((c) => { c.fill = FILL(COLORS.dining); });
    });

    // ---------------- 返利总览 ----------------
    const ov = S.ov;
    ov.columns = [{ width: 30 }, { width: 10 }, { width: 13 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 58 }];
    const t1 = ov.addRow(['返利总览', '', '', '', '', '', '', '']);
    t1.getCell(1).font = { bold: true, size: 14 };
    ov.addRow(['交易日期范围', rows.length ? `${rows[0].date} ~ ${rows[rows.length - 1].date}（共 ${rows.length} 条）` : '']);
    ov.addRow([]);
    styleHeader(ov.addRow(['返利项目', '返利率', '合资格签账', '签账额度', '已用额度', '剩余额度', '预计RC', '说明']));
    const totBase = sumF(rows, 'baseRC');
    const mobSpend = sumF(rows, 'mobAmt'), mobRCsum = sumF(rows, 'mobRC');
    const wSp = sumF(rows, 'worldAmt'), wRCsum = sumF(rows, 'worldRC');
    const mobRC = mobSpend <= pv.MOB_CAP ? mobRCsum : xround(pv.MOB_CAP * pv.MOB_RATE);
    const worldRC = Math.min(wSp <= pv.WORLD_CAP ? wRCsum : xround(pv.WORLD_CAP * pv.WORLD_RATE), pv.WORLD_RC_CAP);
    const rhBonus = sum(months.map((m) => moVals[m].bonus));
    const welReward = wReached ? pv.W_BASE_RC + wQrRC : 0;
    const rcGrand = totBase + mobRC + worldRC + rhBonus + welReward;
    // 第 5~9 行
    const ovRows = [
      ['① 基础奖赏', FX(pref.BASE_RATE, pv.BASE_RATE), FX(`SUM(${R('baseAmt')})`, sumF(rows, 'baseAmt')), null, null, null,
        FX(`SUM(${R('baseRC')})`, totBase), '所有消费'],
      ['② Pulse 特别奖赏', FX(pref.MOB_RATE, pv.MOB_RATE), FX(`SUM(${R('mobAmt')})`, mobSpend), FX(pref.MOB_CAP, pv.MOB_CAP),
        FX('MIN(C6,D6)', Math.min(mobSpend, pv.MOB_CAP)), FX('D6-E6', pv.MOB_CAP - Math.min(mobSpend, pv.MOB_CAP)),
        FX(`IF(C6<=D6,SUM(${R('mobRC')}),ROUND(D6*B6,2))`, mobRC), '云闪付 QR / Apple·Google·Samsung Pay，限内地及澳门'],
      ['③ 赏世界', FX(pref.WORLD_RATE, pv.WORLD_RATE), FX(`SUM(${R('worldAmt')})`, wSp), FX(pref.WORLD_CAP, pv.WORLD_CAP),
        FX('MIN(C7,D7)', Math.min(wSp, pv.WORLD_CAP)), FX('D7-E7', pv.WORLD_CAP - Math.min(wSp, pv.WORLD_CAP)),
        FX(`MIN(IF(C7<=D7,SUM(${R('worldRC')}),ROUND(D7*B7,2)),${pref.WORLD_RC_CAP})`, worldRC), '香港以外，年度 RC 上限 2,000'],
      ['④ 内地餐饮', FX(pref.RH_RATE, pv.RH_RATE), FX(`SUM(${R('rhDining')})`, sumF(rows, 'rhDining')), null, null, null,
        FX(`'按月汇总'!${ML.bonus}${moTot}`, rhBonus), '当月内地签账满门槛才有，审核后到账'],
      ['⑤ 迎新礼', null, FX(WC.spend, wSpend), FX(pref.W_THR, pv.W_THR), null, FX(WC.gap, Math.max(0, pv.W_THR - wSpend)),
        FX(WC.reward, welReward), '满门槛 800 + QR 每笔 10（需邀请码）；审核后到账；剩余额度列 = 距门槛还差'],
    ];
    for (const v of ovRows) {
      const r = ov.addRow(v);
      r.getCell(2).numFmt = PCT;
      for (const c of [3, 4, 5, 6, 7]) r.getCell(c).numFmt = MONEY;
      r.getCell(1).font = { bold: true };
      r.getCell(8).alignment = { wrapText: true };
    }
    const rTot = ov.addRow(['合计', null, null, null, null, null, FX('SUM(G5:G9)', rcGrand), '']);
    rTot.eachCell((c) => { c.font = { bold: true }; c.fill = FILL(COLORS.ok); });
    rTot.getCell(7).numFmt = MONEY;
    const sp = sumF(rows, 'baseAmt');
    const rr = ov.addRow(['综合返现率', null, null, null, null, null, FX('IF(C5=0,0,G10/C5)', sp ? rcGrand / sp : 0), '= 合计 RC ÷ 合资格签账']);
    rr.getCell(7).numFmt = PCT; rr.getCell(1).font = { bold: true };
    const r12 = ov.addRow(['其中 逐笔到账（①+②+③）', null, null, null, null, null, FX('G5+G6+G7', totBase + mobRC + worldRC), '可在「按入账日对账」逐日核对']);
    r12.getCell(7).numFmt = MONEY;
    const r13 = ov.addRow(['其中 达标后审核到账（④+⑤）', null, null, null, null, null, FX('G8+G9', rhBonus + welReward), '']);
    r13.getCell(7).numFmt = MONEY;
    ov.addRow([]);

    styleHeader(ov.addRow(['④ 内地餐饮（按历月）', '内地签账', '门槛', '距达标', '是否达标', '合资格餐饮', '额外RC', '达标后可得 / 餐饮再刷多少封顶']));
    for (const m of months) {
      const n = moRow[m];
      const g = (k) => moVals[m][k];
      const ref = (k) => `'按月汇总'!$${ML[k]}$${n}`;
      const r = ov.addRow([m, FX(ref('rh'), g('rh')), FX(pref.RH_THR, pv.RH_THR), FX(ref('gap'), g('gap')), FX(ref('reach'), g('reach')),
        FX(ref('dining'), g('dining')), FX(ref('bonus'), g('bonus')),
        FX(`"可得 $"&${ref('potential')}&"，再刷 "&TEXT(${ref('toCap')},"0.00")&" 封顶"`, `可得 $${g('potential')}，再刷 ${g('toCap').toFixed(2)} 封顶`)]);
      for (const c of [2, 3, 4, 6]) r.getCell(c).numFmt = MONEY;
      r.getCell(7).numFmt = '#,##0';
      r.getCell(5).fill = FILL(g('reach').startsWith('✔') ? COLORS.ok : COLORS.no);
    }
    ov.addRow([]);
    styleHeader(ov.addRow(['⑤ 迎新礼进度', '值', '', '', '', '', '', '']));
    const wl = (label, ref, res, fmt) => { const r = ov.addRow([label, FX(ref, res)]); r.getCell(1).font = { bold: true }; if (fmt) r.getCell(2).numFmt = fmt; return r; };
    wl('发卡日（参数表可改）', WC.issue, xdate(pv.W_ISSUE), DATE).getCell(3).value = P.issueEstimated ? '⚠ 估算值' : '';
    wl('窗口截止日', WC.end, xdate(rows.wEnd), DATE);
    wl('剩余天数', WC.left, rows.wEnd ? Math.max(0, daysBetween(today, rows.wEnd) + 1) : 0, '0');
    wl('累积签账', WC.spend, wSpend, MONEY);
    wl('距门槛还差', WC.gap, Math.max(0, pv.W_THR - wSpend), MONEY);
    wl('QR≥50 计入次数', WC.times, wTimes, '0');
    wl('QR 每笔奖赏', WC.potential, wQrRC, '#,##0');
    wl('当前预计可得', WC.reward, welReward, '#,##0');
    for (const r of [ov.getRow(2)]) r.getCell(2).alignment = { horizontal: 'left' };

    // ---------------- 说明 ----------------
    const ns = S.ns;
    ns.columns = [{ width: 24 }, { width: 100 }];
    const notes = [
      ['导出时间', new Date().toLocaleString()],
      ['持续活动', '① 基础奖赏 0.4%：所有消费\n② Pulse 特别奖赏 2%：云闪付 QR / Apple Pay / Google Pay / Samsung Pay，限内地及澳门，2026 下半年签账额度 80,000\n③ 赏世界 2%：香港以外，年度签账额度 100,000、RC 上限 2,000\n→ 内地 QR/Apple Pay = 4.4%，内地 SALES = 2.4%'],
      ['④ 内地餐饮 3%', '当月内地合资格签账（所有类别）≥ 1,200，当月内地餐饮（MCC 5812/5813/5814，不含宴会 5811）额外 3%，每月上限 80，向上取整；审核后统一到账'],
      ['⑤ 迎新礼', '发卡后首 60 个历日累积合资格签账满 8,000 → 800 RC；填写邀请码的，窗口内每笔云闪付 QR ≥ 50 另加 10 RC，最多 28 笔；附属卡不计；达标后审核到账'],
      ['退款', '按"同卡 + 同授权码"匹配原消费；退款行继承原消费的渠道和地区，RC 在退款入账日按负数扣回'],
      ['公式', '所有汇总数值都是公式，引用「交易明细」和「参数」。改参数表的黄色格子、或改明细里橙色表头的「计返利」「餐饮」列，都会自动重算'],
      ['表头颜色', '蓝色 = 原始数据；绿色 = 公式；橙色 = 可手动修改'],
      ['单元格颜色', '交易详情红底 = QR、绿底 = Apple Pay；商户类型黄底 = 餐饮；金额蓝底 = 退款'],
      ['授权码', '授权码(authorizationCode)是每笔交易的随机授权号，不代表商户类型；商户类型取自 merchantCategoryCode (MCC)'],
      ['注意', '新增交易行请插在明细表合计行之上，否则汇总公式不会包含；月份/账单周期列表是导出时生成的，改「归属日期」参数后若出现新月份需重新导出'],
      ['免责', '以上为按条款估算，实际以汇丰判定及入账为准'],
    ];
    for (const [k, v] of notes) {
      const r = ns.addRow([k, v]);
      r.getCell(1).font = { bold: true };
      r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
      r.getCell(1).alignment = { vertical: 'top' };
    }
    ns.addRow([]);
    styleHeader(ns.addRow(['MCC', '商户类型对照']));
    for (const [k, v] of Object.entries(MCC_NAMES)) ns.addRow([k, v]);

    return wb;
  }

  // 供面板/测试快速查看的摘要
  function quickSummary(rows) {
    const p = rows.params.values;
    const months = [...new Set(rows.map((r) => r.month))].sort().map((m) => {
      const list = rows.filter((r) => r.month === m);
      const rh = sum(list.map((r) => r.rhAmt)), dining = sum(list.map((r) => r.rhDining));
      return { m, rh: round2(rh), dining: round2(dining), bonus: rh >= p.RH_THR ? Math.ceil(Math.min(dining * p.RH_RATE, p.RH_CAP) - 1e-9) : 0 };
    });
    return {
      base: round2(sum(rows.map((r) => r.baseRC))), mob: round2(sum(rows.map((r) => r.mobRC))), world: round2(sum(rows.map((r) => r.worldRC))),
      spend: round2(sum(rows.map((r) => r.baseAmt))), welSpend: round2(sum(rows.map((r) => r.welAmt))), welQR: sum(rows.map((r) => r.welQR)), months,
    };
  }

  const Core = {
    CONFIG, MCC_NAMES, mccName, detectChannel, normalize, computeModel, applyOverrides, buildWorkbook, quickSummary,
    slimTx, parseHar, dedupe, mergeStore, cardOf, splitByCard, xround, stmtDateOf, addDays, daysBetween, ymd,
  };

  // ============================================================
  // 运行环境判断
  //  - Node 测试 / 看板网页用 <script> 直接加载：只导出核心逻辑
  //  - 油猴 @ 汇丰：拦截交易请求 + 面板 + 把账单累计保存到油猴存储
  //  - 油猴 @ 看板：把油猴存储里的账单交给看板页面（postMessage，同源）
  // ============================================================
  const HAS_GM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  const HERE = typeof location !== 'undefined' ? location : null;
  const IS_HSBC = !!HERE && /(^|\.)hsbc\.com\.hk$/.test(HERE.hostname);
  const IS_VIEWER = !!HERE && CONFIG.VIEWER_ORIGINS.includes(HERE.origin);
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof window !== 'undefined' && !window.HSBCBillCore) window.HSBCBillCore = Core;
  // 看板网页用 <script src="core.js" data-bill-core> 加载时只当计算库用
  // （不能只看 document.currentScript：油猴本身也是用 <script> 注入的）
  const AS_LIBRARY = typeof document !== 'undefined' && !!document.currentScript
    && typeof document.currentScript.hasAttribute === 'function' && document.currentScript.hasAttribute('data-bill-core');
  if (!HAS_GM || AS_LIBRARY || !(IS_HSBC || IS_VIEWER)) return;

  const STORE_KEY = 'bill-store-v1';
  const SETTINGS_KEY = 'bill-settings-v1';
  const readStore = () => GM_getValue(STORE_KEY, null);
  const loadSettings = () => GM_getValue(SETTINGS_KEY, {}) || {};
  const saveSettings = (s) => GM_setValue(SETTINGS_KEY, s);

  // ---------------- 看板页面：数据桥 ----------------
  if (IS_VIEWER) {
    const send = () => {
      const store = readStore();
      window.postMessage({
        type: 'br-data',
        payload: store ? { ...store, settings: { ...(store.settings || {}), ...loadSettings() } } : null,
      }, HERE.origin);
    };
    window.addEventListener('message', (e) => {
      if (e.origin !== HERE.origin || !e.data || typeof e.data !== 'object') return;
      if (e.data.type === 'br-request') send();
      if (e.data.type === 'br-clear') { GM_deleteValue(STORE_KEY); send(); }
    });
    if (typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener(STORE_KEY, (name, oldV, newV, remote) => { if (remote) send(); });
    }
    return;
  }

  // ============================================================
  // 汇丰页面：拦截网页请求，捕获交易数据
  // ============================================================
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window; // 页面真实 window
  const TX_RE = /\/v2\/transactions\?/;
  const ACCT_RE = /\/accounts\/credit-cards\//;
  const state = { txs: [], templates: new Map(), statementDay: null, ui: null, saveTimer: null };

  function ingestJSON(url, data) {
    try {
      if (TX_RE.test(url) && data && Array.isArray(data.transactions)) {
        state.txs = dedupe(state.txs.concat(data.transactions));
        scheduleSave();
        updateUI();
      } else if (ACCT_RE.test(url) && data?.creditCardAccountDetail) {
        const sd = data.creditCardAccountDetail.lastStatementCycle?.statementDate;
        if (sd) { state.statementDay = Number(sd.slice(8, 10)); scheduleSave(); }
        updateUI();
      }
    } catch (e) { console.warn('[账单导出] 解析失败', e); }
  }

  // ---- 累计保存到油猴存储（看板读取）----
  function saveNow() {
    clearTimeout(state.saveTimer);
    if (!state.txs.length && !state.statementDay) return readStore();
    const old = readStore() || {};
    const txs = mergeStore(old.txs || [], state.txs.map(slimTx));
    const store = {
      v: 1,
      updatedAt: new Date().toISOString(),
      statementDay: state.statementDay || old.statementDay || CONFIG.STATEMENT_DAY,
      txs,
    };
    GM_setValue(STORE_KEY, store);
    updateUI();
    return store;
  }
  function scheduleSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveNow, 800);
  }

  function rememberTemplate(url, headers) {
    if (!TX_RE.test(url)) return;
    try {
      const u = new URL(url, location.href);
      const id = u.searchParams.get('identifier');
      if (!id) return;
      u.searchParams.delete('nextPageIndex');
      state.templates.set(id, { url: u.toString(), headers: { ...headers } });
    } catch (e) { /* ignore */ }
  }

  // ---- XHR hook（挂在页面真实的 XMLHttpRequest 上）----
  const XP = W.XMLHttpRequest.prototype;
  const XO = XP.open, XS = XP.send, XH = XP.setRequestHeader;
  XP.open = function (method, url, ...rest) {
    this.__hbUrl = String(url);
    this.__hbHeaders = {};
    return XO.call(this, method, url, ...rest);
  };
  XP.setRequestHeader = function (k, v) {
    if (this.__hbHeaders) this.__hbHeaders[k] = v;
    return XH.call(this, k, v);
  };
  XP.send = function (...args) {
    const url = this.__hbUrl || '';
    if (TX_RE.test(url) || ACCT_RE.test(url)) {
      rememberTemplate(url, this.__hbHeaders || {});
      this.addEventListener('load', () => {
        try {
          const data = this.responseType === 'json' ? this.response
            : JSON.parse(this.responseType === '' || this.responseType === 'text' ? this.responseText : '');
          ingestJSON(url, data);
        } catch (e) { /* ignore */ }
      });
    }
    return XS.apply(this, args);
  };

  // ---- fetch hook ----
  const origFetch = W.fetch.bind(W);
  W.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url || String(input || ''));
    const res = await origFetch(input, init);
    if (TX_RE.test(url) || ACCT_RE.test(url)) {
      try {
        const h = {};
        const hs = init?.headers || (input && typeof input === 'object' && input.headers ? input.headers : null);
        if (hs) new W.Headers(hs).forEach((v, k) => { h[k] = v; });
        rememberTemplate(url, h);
        res.clone().json().then((d) => ingestJSON(url, d)).catch(() => {});
      } catch (e) { /* ignore */ }
    }
    return res;
  };

  // ---- 主动翻页拉取 ----
  async function fetchAll() {
    if (!state.templates.size) {
      alert('还没有捕获到交易查询请求。\n请先在网页上打开信用卡的「交易记录」页面，等记录加载出来后再点「拉取全部」。');
      return;
    }
    let pages = 0;
    for (const [, tpl] of state.templates) {
      let next = null;
      for (let i = 0; i < 200; i++) {
        const u = new URL(tpl.url);
        if (next) u.searchParams.set('nextPageIndex', next);
        setStatus(`正在拉取第 ${i + 1} 页…`);
        const res = await origFetch(u.toString(), { headers: tpl.headers, credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data.transactions)) throw new Error('返回数据格式异常：' + JSON.stringify(data).slice(0, 200));
        state.txs = dedupe(state.txs.concat(data.transactions));
        pages++;
        updateUI();
        const p = data.pagination || {};
        if (p.moreRecord !== 'Y' || !p.nextPageIndex) break;
        next = p.nextPageIndex;
      }
    }
    saveNow();
    setStatus(`拉取完成：${pages} 页，本次 ${state.txs.length} 条`);
  }

  // ---- 导入 HAR（离线备用） ----
  function importHar(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const { txs, statementDay } = parseHar(fr.result);
        state.txs = dedupe(state.txs.concat(txs));
        if (statementDay) state.statementDay = statementDay;
        saveNow();
        setStatus(`HAR 导入完成：${txs.length} 条`);
      } catch (err) { alert('HAR 解析失败：' + err.message); }
    };
    fr.readAsText(file);
  }

  async function exportExcel() {
    const store = saveNow();
    const txs = store?.txs?.length ? store.txs : state.txs;
    if (!txs.length) { alert('还没有交易数据。请先打开交易记录页面，或点「拉取全部」/「导入HAR」。'); return; }
    if (typeof ExcelJS === 'undefined') { alert('ExcelJS 未加载（检查油猴 @require 是否被拦截）'); return; }
    const st = loadSettings();
    const day = state.statementDay || store?.statementDay || CONFIG.STATEMENT_DAY;
    const opts = { statementDay: day, cardIssueDate: st.issue || '', redhotRegDate: st.reg || '' };
    const d = new Date();
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    // 每个卡号单独一个文件：卡号不同额度不同，不能混在一起算
    const done = [];
    for (const [card, list] of splitByCard(txs)) {
      const rows = normalize(list, CONFIG, opts);
      const wb = await buildWorkbook(ExcelJS, rows, CONFIG, opts);
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a');
      a.download = `信用卡账单_${card}_${stamp}.xlsx`;
      a.href = URL.createObjectURL(blob);
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      done.push(`${card}（${rows.length} 条）`);
      await new Promise((r) => setTimeout(r, 400)); // 连续下载间隔一下，避免被浏览器合并拦截
    }
    setStatus(`已导出：${done.join('、')}`);
  }

  // ---- 打开在线看板（数据由看板页上的同一个脚本从油猴存储读取，不经过网址和服务器）----
  function openViewer() {
    const store = saveNow();
    if (!store?.txs?.length) { alert('还没有交易数据。请先打开交易记录页面，或点「拉取全部」/「导入HAR」。'); return; }
    window.open(CONFIG.VIEWER_URL, '_blank', 'noopener,noreferrer');
    setStatus(`已打开在线看板（累计 ${store.txs.length} 条）`);
  }

  // ============================================================
  // 悬浮面板
  // ============================================================
  function setStatus(msg) { if (state.ui) state.ui.status.textContent = msg; }
  function updateUI() {
    if (!state.ui) return;
    const savedTxs = readStore()?.txs || [];
    const cards = [...splitByCard(savedTxs)].map(([c, l]) => `${c}: ${l.length}`).join('，');
    state.ui.count.textContent = `本次捕获 ${state.txs.length} 条 · 已保存 ${savedTxs.length} 条${cards ? `（${cards}）` : ''}${state.statementDay ? ` · 账单日 ${state.statementDay} 号` : ''}`;
  }

  function mountUI() {
    if (state.ui || !document.body) return;
    const st = loadSettings();
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#fff;border:1px solid #db0011;'
      + 'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.2);padding:10px 12px;font:13px/1.5 sans-serif;color:#333;width:250px';
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;font-weight:bold;color:#db0011">
        <span>账单导出</span><span data-x style="cursor:pointer;color:#999">－</span></div>
      <div data-body>
        <div data-count style="margin:4px 0"></div>
        <label style="display:flex;justify-content:space-between;margin:2px 0">发卡日 <input type="date" data-issue style="width:130px"></label>
        <label style="display:flex;justify-content:space-between;margin:2px 0">最红登记日 <input type="date" data-reg style="width:130px"></label>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">
          <button data-fetch>拉取全部</button>
          <button data-view style="background:#db0011;color:#fff;border:0;border-radius:4px;padding:2px 8px">在线查看</button>
          <button data-export>导出 Excel</button>
          <button data-har>导入HAR</button>
          <button data-clear>清空已保存</button>
        </div>
        <div data-status style="margin-top:4px;color:#888;font-size:12px"></div>
        <input type="file" accept=".har,application/json" data-file style="display:none">
      </div>`;
    document.body.appendChild(box);
    const q = (s) => box.querySelector(s);
    state.ui = { count: q('[data-count]'), status: q('[data-status]') };
    q('[data-issue]').value = st.issue || '';
    q('[data-reg]').value = st.reg || '';
    const persist = () => saveSettings({ ...loadSettings(), issue: q('[data-issue]').value, reg: q('[data-reg]').value });
    q('[data-issue]').onchange = persist;
    q('[data-reg]').onchange = persist;
    q('[data-x]').onclick = () => { const b = q('[data-body]'); b.style.display = b.style.display === 'none' ? '' : 'none'; };
    q('[data-fetch]').onclick = () => fetchAll().catch((e) => { setStatus('拉取失败：' + e.message); alert('主动拉取失败：' + e.message + '\n可在网页上手动点「显示更多」翻页，脚本会自动捕获。'); });
    q('[data-export]').onclick = () => exportExcel().catch((e) => { console.error(e); alert('导出失败：' + e.message); });
    q('[data-view]').onclick = () => { try { openViewer(); } catch (e) { console.error(e); alert('打开在线看板失败：' + e.message); } };
    q('[data-har]').onclick = () => q('[data-file]').click();
    q('[data-file]').onchange = (e) => { if (e.target.files[0]) importHar(e.target.files[0]); e.target.value = ''; };
    q('[data-clear]').onclick = () => {
      if (!confirm('清空油猴里累计保存的全部账单？（本次捕获的也一并清空）')) return;
      GM_deleteValue(STORE_KEY); state.txs = []; updateUI(); setStatus('已清空');
    };
    updateUI();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountUI);
  else mountUI();
  setInterval(() => { if (state.ui && !document.body.contains(state.ui.count)) state.ui = null; mountUI(); }, 3000);
})();
