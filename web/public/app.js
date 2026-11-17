/* 账单返利看板：纯前端。数据来源：同一个油猴脚本（从油猴存储读取后 postMessage 给本页），或手动导入 HAR/JSON。 */
(function () {
  'use strict';
  const Core = window.HSBCBillCore;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // ---------------- 本机存储（只放便利性设置，失败不影响使用） ----------------
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const SS = {
    get(k) { try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 超出配额就不缓存 */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  // ---------------- 状态 ----------------
  let data = null;          // { txs, statementDay, settings, source }
  // 参数、实际到账按卡号分别保存：{ 卡号后四位: {...} }
  let paramsAll = LS.get('br:params-card', null);
  let actualsAll = LS.get('br:actual-card', null);
  let overrides = LS.get('br:overrides', { elig: {}, dining: {} });
  // 当前选中的卡（选「全部」时 params/actuals/cfg/opts 为 null）
  let params = null, actuals = null;
  let rows = null, defaults = null, cfg = null, opts = null, sum = null;
  let units = [];           // 每张卡一份：{ card, cfg, opts, rows, defaults, sum, params, actuals }
  let bridge = false;
  let showPending = LS.get('br:pending', true);
  const ui = { card: LS.get('br:card', ''), tab: 'tx', dailyMode: 'txn', f: { q: '', ch: '', month: '', dining: false, noelig: false } };

  // ---------------- 格式化 ----------------
  const nf2 = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf0 = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
  const money = (n) => (n < -0.0049 ? '−' : '') + nf2.format(Math.abs(n || 0));
  const int = (n) => nf0.format(n || 0);
  const pct = (n, d = 2) => `${((n || 0) * 100).toFixed(d)}%`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const md = (s) => (s ? s.slice(5) : '');
  const today = () => Core.ymd(new Date());

  // ---------------- 参数定义（映射到 Core.CONFIG） ----------------
  const FIELDS = [
    { g: '通用', k: 'periodBy', l: '归属日期', t: 'select', o: [['post', '入账日'], ['txn', '交易日']], get: (c) => c.PERIOD_BY, set: (c, v) => { c.PERIOD_BY = v; } },
    { g: '通用', k: 'stmtDay', l: '账单日（每月几号）', t: 'number', step: 1, opt: true },
    { g: '通用', k: 'noMcc', l: '默认不计返利的 MCC', t: 'text', get: (c) => (c.DEFAULT_NO_MCC || []).join(','), set: (c, v) => { c.DEFAULT_NO_MCC = String(v).split(/[,，\s]+/).filter(Boolean); } },
    { g: '① 基础奖赏', k: 'baseRate', l: '返利率 %', t: 'pct', get: (c) => c.BASE_RATE, set: (c, v) => { c.BASE_RATE = v; } },
    { g: '② Pulse 特别奖赏', k: 'mobRate', l: '返利率 %', t: 'pct', get: (c) => c.MOBILE.RATE, set: (c, v) => { c.MOBILE.RATE = v; } },
    { g: '② Pulse 特别奖赏', k: 'mobRegions', l: '适用地区代码', t: 'text', get: (c) => c.MOBILE.REGIONS, set: (c, v) => { c.MOBILE.REGIONS = v; } },
    { g: '② Pulse 特别奖赏', k: 'mobStart', l: '计算开始', t: 'date', get: (c) => c.MOBILE.START, set: (c, v) => { c.MOBILE.START = v; } },
    { g: '② Pulse 特别奖赏', k: 'mobEnd', l: '计算结束', t: 'date', get: (c) => c.MOBILE.END, set: (c, v) => { c.MOBILE.END = v; } },
    { g: '② Pulse 特别奖赏', k: 'mobCap', l: '签账额度', t: 'number', get: (c) => c.MOBILE.CAP, set: (c, v) => { c.MOBILE.CAP = v; } },
    { g: '③ 赏世界', k: 'worldOn', l: '已登记', t: 'select', o: [['1', '是'], ['0', '否']], get: (c) => (c.WORLD.ENABLED ? '1' : '0'), set: (c, v) => { c.WORLD.ENABLED = v === '1'; } },
    { g: '③ 赏世界', k: 'worldRate', l: '返利率 %', t: 'pct', get: (c) => c.WORLD.RATE, set: (c, v) => { c.WORLD.RATE = v; } },
    { g: '③ 赏世界', k: 'worldReg', l: '登记日（之前不计）', t: 'date', get: (c) => c.WORLD.REG_DATE, set: (c, v) => { c.WORLD.REG_DATE = v; } },
    { g: '③ 赏世界', k: 'worldStart', l: '计算开始', t: 'date', get: (c) => c.WORLD.START, set: (c, v) => { c.WORLD.START = v; } },
    { g: '③ 赏世界', k: 'worldEnd', l: '计算结束', t: 'date', get: (c) => c.WORLD.END, set: (c, v) => { c.WORLD.END = v; } },
    { g: '③ 赏世界', k: 'worldCap', l: '年度签账额度', t: 'number', get: (c) => c.WORLD.CAP, set: (c, v) => { c.WORLD.CAP = v; } },
    { g: '③ 赏世界', k: 'worldRcCap', l: '年度 RC 上限', t: 'number', get: (c) => c.WORLD.RC_CAP, set: (c, v) => { c.WORLD.RC_CAP = v; } },
    { g: '④ 内地餐饮', k: 'rhReg', l: 'Reward+ 登记日', t: 'date', get: (c) => c.REDHOT.REG_DATE, set: (c, v) => { c.REDHOT.REG_DATE = v; } },
    { g: '④ 内地餐饮', k: 'rhStart', l: '推广开始', t: 'date', get: (c) => c.REDHOT.START, set: (c, v) => { c.REDHOT.START = v; } },
    { g: '④ 内地餐饮', k: 'rhEnd', l: '推广结束', t: 'date', get: (c) => c.REDHOT.END, set: (c, v) => { c.REDHOT.END = v; } },
    { g: '④ 内地餐饮', k: 'rhThr', l: '每月内地签账门槛', t: 'number', get: (c) => c.REDHOT.THRESHOLD, set: (c, v) => { c.REDHOT.THRESHOLD = v; } },
    { g: '④ 内地餐饮', k: 'rhRate', l: '餐饮返利 %', t: 'pct', get: (c) => c.REDHOT.RATE, set: (c, v) => { c.REDHOT.RATE = v; } },
    { g: '④ 内地餐饮', k: 'rhCap', l: '每月上限', t: 'number', get: (c) => c.REDHOT.CAP_PER_MONTH, set: (c, v) => { c.REDHOT.CAP_PER_MONTH = v; } },
    { g: '⑤ 迎新礼', k: 'issue', l: '发卡日', t: 'date', get: (c) => c.WELCOME.CARD_ISSUE_DATE, set: (c, v) => { c.WELCOME.CARD_ISSUE_DATE = v; } },
    { g: '⑤ 迎新礼', k: 'wDays', l: '计算天数', t: 'number', get: (c) => c.WELCOME.DAYS, set: (c, v) => { c.WELCOME.DAYS = v; } },
    { g: '⑤ 迎新礼', k: 'wThr', l: '累积签账门槛', t: 'number', get: (c) => c.WELCOME.THRESHOLD, set: (c, v) => { c.WELCOME.THRESHOLD = v; } },
    { g: '⑤ 迎新礼', k: 'wQrMin', l: 'QR 单笔最低', t: 'number', get: (c) => c.WELCOME.QR_MIN, set: (c, v) => { c.WELCOME.QR_MIN = v; } },
    { g: '⑤ 迎新礼', k: 'wQrRc', l: 'QR 每笔奖赏 RC', t: 'number', get: (c) => c.WELCOME.QR_REWARD, set: (c, v) => { c.WELCOME.QR_REWARD = v; } },
    { g: '⑤ 迎新礼', k: 'wQrMax', l: 'QR 最多次数', t: 'number', get: (c) => c.WELCOME.QR_MAX_TIMES, set: (c, v) => { c.WELCOME.QR_MAX_TIMES = v; } },
    { g: '⑤ 迎新礼', k: 'wBase', l: '满门槛奖赏 RC', t: 'number', get: (c) => c.WELCOME.BASE_REWARD, set: (c, v) => { c.WELCOME.BASE_REWARD = v; } },
    { g: '⑤ 迎新礼', k: 'invite', l: '已填写邀请码', t: 'select', o: [['1', '是'], ['0', '否']], get: (c) => (c.WELCOME.INVITE ? '1' : '0'), set: (c, v) => { c.WELCOME.INVITE = v === '1'; } },
  ];

  function paramsOf(card) { if (!paramsAll[card]) paramsAll[card] = {}; return paramsAll[card]; }
  function actualsOf(card) { if (!actualsAll[card]) actualsAll[card] = {}; return actualsAll[card]; }
  function saveParams() { LS.set('br:params-card', paramsAll); }
  function saveActuals() { LS.set('br:actual-card', actualsAll); }
  /** 旧版只有一套参数/实际到账：参数复制给每张卡，实际到账归给笔数最多的卡 */
  function migrate(cards) {
    if (!paramsAll) {
      const old = LS.get('br:params', {});
      paramsAll = {};
      for (const c of cards) paramsAll[c] = { ...old };
      saveParams();
    }
    if (!actualsAll) {
      const old = LS.get('br:actual', {});
      actualsAll = {};
      if (Object.keys(old).length && cards[0]) actualsAll[cards[0]] = old;
      saveActuals();
    }
  }

  function buildCfg(params) {
    const c = structuredClone(Core.CONFIG);
    // 来自油猴面板的设置（发卡日 / 最红登记日）作为默认值
    const st = data?.settings || {};
    if (st.issue) c.WELCOME.CARD_ISSUE_DATE = st.issue;
    if (st.reg) c.REDHOT.REG_DATE = st.reg;
    for (const f of FIELDS) if (f.set && params[f.k] !== undefined && params[f.k] !== null) f.set(c, params[f.k]);  // 当前卡的参数
    const sd = Number(params.stmtDay) || data?.statementDay || c.STATEMENT_DAY;
    return { c, o: { statementDay: sd } };
  }

  // ---------------- 计算 ----------------
  function compute() {
    const groups = Core.splitByCard(data.txs);
    const cards = [...groups.keys()];
    migrate(cards);
    units = cards.map((card) => {
      const pr = paramsOf(card);
      const { c, o } = buildCfg(pr);
      const rs = Core.normalize(groups.get(card), c, o);
      const def = new Map(rs.map((r) => [r.id, { elig: r.elig, dining: r.dining }]));
      Core.applyOverrides(rs, overrides);
      return { card, cfg: c, opts: o, rows: rs, defaults: def, sum: summarize(rs), params: pr, actuals: actualsOf(card) };
    });
    // 只有一张卡时不提供「全部」
    if (!cards.includes(ui.card) && (ui.card !== '' || cards.length < 2)) ui.card = cards.length > 1 ? '' : cards[0];
    const u = units.find((x) => x.card === ui.card);
    if (u) {
      ({ rows, cfg, opts, sum, defaults, params, actuals } = u);
    } else {
      rows = units.flatMap((x) => x.rows).sort((a, b) => a.date.localeCompare(b.date) || String(a.time).localeCompare(String(b.time)));
      defaults = new Map(units.flatMap((x) => [...x.defaults]));
      cfg = opts = params = actuals = null;
      sum = combine(units);
    }
  }
  const unitOf = (card) => units.find((x) => x.card === card);
  const isAll = () => !unitOf(ui.card);

  /** 「全部」：各卡分别算好再相加（额度按卡号各自计算） */
  function combine(us) {
    const S = (k) => us.reduce((a, u) => a + u.sum[k], 0);
    const W = (k) => us.reduce((a, u) => a + u.sum.wel[k], 0);
    return {
      p: us[0].sum.p, all: true,
      base: S('base'), spend: S('spend'), mobAmt: S('mobAmt'), mob: S('mob'), worldAmt: S('worldAmt'), world: S('world'),
      rhBonus: S('rhBonus'), refunds: S('refunds'), total: S('total'), instant: S('instant'), later: S('later'), count: S('count'),
      months: [],
      wel: { reward: W('reward'), potential: W('potential'), reachedN: us.filter((u) => u.sum.wel.reached).length, n: us.length },
    };
  }
  /** 「全部」时各卡参数不一定相同：相同就显示，不同显示「各卡不同」 */
  function sameP(fn) {
    const v = units.map((u) => fn(u.sum.p));
    return v.every((x) => x === v[0]) ? v[0] : '各卡不同';
  }

  function summarize(rs) {
    const p = rs.params.values;
    const S = (k, pred) => rs.reduce((a, r) => a + (!pred || pred(r) ? r[k] : 0), 0);
    const base = S('baseRC'), spend = S('baseAmt');
    const mobAmt = S('mobAmt'), mobSum = S('mobRC');
    const mob = mobAmt <= p.MOB_CAP ? mobSum : Core.xround(p.MOB_CAP * p.MOB_RATE);
    const worldAmt = S('worldAmt'), worldSum = S('worldRC');
    const world = Math.min(worldAmt <= p.WORLD_CAP ? worldSum : Core.xround(p.WORLD_CAP * p.WORLD_RATE), p.WORLD_RC_CAP);
    const months = [...new Set(rs.map((r) => r.month))].sort().map((m) => {
      const pred = (r) => r.month === m;
      const rh = S('rhAmt', pred), dining = S('rhDining', pred);
      const potential = Math.ceil(Math.min(dining * p.RH_RATE, p.RH_CAP) - 1e-9);
      const reach = rh >= p.RH_THR;
      return {
        m, rh, dining, reach, potential, bonus: reach ? potential : 0,
        gap: Math.max(0, p.RH_THR - rh), toCap: Math.max(0, p.RH_CAP / p.RH_RATE - dining),
        spend: S('baseAmt', pred), rc: S('baseRC', pred) + S('mobRC', pred) + S('worldRC', pred),
      };
    });
    const rhBonus = months.reduce((a, x) => a + x.bonus, 0);
    const wSpend = S('welAmt'), wCount = S('welQR');
    const wTimes = Math.min(wCount, p.W_QR_MAX);
    const wReached = wSpend >= p.W_THR;
    const invite = p.W_INVITE === '是';
    const wQr = invite ? wTimes * p.W_QR_RC : 0;
    const welReward = wReached ? p.W_BASE_RC + wQr : 0;
    const welMax = p.W_BASE_RC + (invite ? p.W_QR_MAX * p.W_QR_RC : 0);
    const wEnd = rs.wEnd;
    const daysLeft = wEnd ? Math.max(0, Core.daysBetween(today(), wEnd) + 1) : 0;
    const refunds = -S('amount', (r) => r.channel === 'RETURN');
    const total = base + mob + world + rhBonus + welReward;
    return {
      p, base, spend, mobAmt, mob, worldAmt, world, months, rhBonus, refunds, total,
      wel: { spend: wSpend, count: wCount, times: wTimes, reached: wReached, reward: welReward, end: wEnd, issue: p.W_ISSUE, daysLeft, potential: p.W_BASE_RC + wQr, max: welMax, invite, qr: wQr, pending: S('welAmt', (r) => r.status === '处理中') },
      instant: base + mob + world, later: rhBonus + welReward,
      count: rs.filter((r) => !r.isCredit && r.channel !== 'PAYMENT').length,
    };
  }

  // ---------------- 渲染 ----------------
  function render() {
    const has = !!data?.txs?.length;
    $('#empty').hidden = has;
    $('#dash').hidden = !has;
    $('#btn-export').disabled = !has;
    $('#btn-clear').disabled = !has;
    $('#btn-params').disabled = !has;
    $('#card-sel').hidden = !has;
    if (!has) { renderEmpty(); return; }
    compute();
    renderCardSel();
    $('#btn-params').disabled = isAll();
    $('#btn-params').title = isAll() ? '参数按卡号分别设置，请先选择一张卡' : `修改尾号 ${ui.card} 的参数`;
    const first = rows[0]?.date, last = rows[rows.length - 1]?.date;
    const src = data.source === 'script' ? '油猴脚本' : '导入文件';
    $('#range').textContent = `${first} ~ ${last} · ${rows.length} 条 · 来自${src}${data.updatedAt ? ` · 更新于 ${new Date(data.updatedAt).toLocaleString('zh-CN', { hour12: false })}` : ''}`;
    renderKpis(); renderComp(); renderProgress(); renderDaily(); renderMonths(); renderCats();
    renderTx(); renderRc();
    if ($('#dlg-params').open) { if (isAll()) $('#dlg-params').close(); else renderParams(); }
  }

  function renderCardSel() {
    const sel = $('#card-sel');
    const opt = (v, label) => `<option value="${esc(v)}" ${ui.card === v ? 'selected' : ''}>${esc(label)}</option>`;
    sel.innerHTML = (units.length > 1 ? opt('', `全部 ${units.length} 张卡`) : '')
      + units.map((u) => opt(u.card, `尾号 ${u.card} · ${u.rows.length} 笔`)).join('');
    sel.disabled = units.length < 2;
  }

  function renderEmpty() {
    const note = $('#empty .bridge-note') || Object.assign(document.createElement('p'), { className: 'bridge-note small' });
    note.textContent = bridge
      ? '✔ 已检测到油猴脚本，但油猴里还没有保存账单。请先在汇丰网银用脚本拉取一次。'
      : '未检测到油猴脚本：请确认脚本已更新到最新版，且 @match 包含本网站。';
    note.className = `bridge-note small ${bridge ? 'ok' : 'warn'}`;
    $('#drop').appendChild(note);
  }

  function kpi(label, value, foot, cls = '') {
    return `<div class="kpi ${cls}"><div class="label">${label}</div><div class="value">${value}</div>${foot ? `<div class="foot">${foot}</div>` : ''}</div>`;
  }

  function renderKpis() {
    const s = sum, w = s.wel, p = s.p;
    const total = showPending ? s.total : s.instant;
    $('#kpis').innerHTML = [
      kpi(showPending ? '预计总返利 RC' : '持续活动返利 RC', money(total),
        showPending ? `持续活动 ${money(s.instant)} · 审核中 ${money(s.later)}` : `①基础 + ②Pulse特别 + ③赏世界`, 'hero'),
      kpi('合资格消费', money(s.spend), `${s.count} 笔消费 · 退款 ${money(s.refunds)}`),
      kpi('综合返现率', pct(s.spend ? total / s.spend : 0), showPending ? '含审核中奖赏' : '仅持续活动'),
      s.all
        ? kpi('迎新礼进度', `${w.reachedN} / ${w.n} 张卡`, `已达标的卡预计 ${int(w.reward)} RC`)
        : kpi('迎新礼进度', w.reached ? '✔ 已达标' : pct(Math.min(1, w.spend / p.W_THR), 0),
          w.reached ? `预计 ${int(w.reward)} RC` : `还差 ${money(p.W_THR - w.spend)} · 剩 ${w.daysLeft} 天`),
    ].join('');
  }

  function renderComp() {
    const s = sum, p = s.p, w = s.wel;
    const P = s.all ? sameP : (fn) => fn(p);
    const items = [
      { c: 1, n: '① 基础奖赏', d: '所有消费', r: P((q) => pct(q.BASE_RATE, 1)), v: s.base },
      { c: 2, n: '② Pulse 特别奖赏', d: '云闪付 QR / Apple·Google·Samsung Pay，内地及澳门', r: P((q) => pct(q.MOB_RATE, 1)), v: s.mob },
      { c: 3, n: '③ 赏世界', d: '香港以外', r: P((q) => pct(q.WORLD_RATE, 1)), v: s.world },
      { c: 4, n: '④ 内地餐饮', d: `当月内地消费满 ${P((q) => int(q.RH_THR))}`, r: P((q) => pct(q.RH_RATE, 1)), v: s.rhBonus, later: true },
      s.all
        ? { c: 5, n: '⑤ 迎新礼', d: `${w.reachedN} / ${w.n} 张卡已达标`, r: P((q) => int(q.W_BASE_RC)), v: w.reward, later: true }
        : { c: 5, n: '⑤ 迎新礼', d: w.reached ? `满门槛 ${int(p.W_BASE_RC)}${w.invite ? ` + QR ${w.times} 笔` : ''}` : `满 ${int(p.W_THR)} 后可得 ${int(w.potential)}`, r: w.invite ? `${int(p.W_BASE_RC)}+${p.W_QR_RC}/笔` : int(p.W_BASE_RC), v: w.reward, later: true },
    ];
    const shown = items.filter((x) => showPending || !x.later);
    const total = shown.reduce((a, x) => a + x.v, 0);
    // 环状图
    const R = 80, C = 2 * Math.PI * R, GAP = 2;
    const pos = shown.filter((x) => x.v > 0);
    const tot = pos.reduce((a, x) => a + x.v, 0) || 1;
    let off = 0;
    const arcs = pos.map((x) => {
      const len = (x.v / tot) * C;
      const dash = Math.max(0.5, len - (pos.length > 1 ? GAP : 0));
      const a = `<circle class="seg-arc k${x.c}" cx="100" cy="100" r="${R}" stroke-dasharray="${dash} ${C - dash}" stroke-dashoffset="${-off}" transform="rotate(-90 100 100)" data-i="${items.indexOf(x)}"/>`;
      off += len;
      return a;
    }).join('');
    $('#donut').innerHTML = `<svg viewBox="0 0 200 200" role="img" aria-label="返利构成环状图，合计 ${money(total)}">
      <circle class="ring" cx="100" cy="100" r="${R}"/>${arcs}
      <text class="c-l" x="100" y="88" text-anchor="middle">${showPending ? '预计总返利' : '持续活动返利'}</text>
      <text class="c-v" x="100" y="114" text-anchor="middle">${money(total)}</text>
      <text class="c-l" x="100" y="134" text-anchor="middle">RC</text></svg>`;
    $('#comp').innerHTML = shown.map((x) => `
        <div class="comp-row ${x.later ? 'later' : ''}"><i class="sw b${x.c}"></i><div class="name">${x.n}<small>${x.d}</small></div><div class="rate">${x.r}</div><div class="amt">${money(x.v)}</div></div>`).join('')
      + `<div class="comp-total"><span>合计 <span class="muted small">占合资格消费 ${pct(s.spend ? total / s.spend : 0)}</span></span><span>${money(total)}</span></div>`
      + (showPending ? '' : `<div class="comp-hidden">已隐藏审核中奖赏：④ 内地餐饮 ${money(s.rhBonus)} · ⑤ 迎新礼 ${money(w.reward)}</div>`);
    const sw = $('#btn-pending');
    sw.setAttribute('aria-checked', String(showPending));
    const tip = $('#tip');
    $$('#donut .seg-arc').forEach((el) => {
      const x = items[Number(el.dataset.i)];
      el.addEventListener('mouseenter', () => {
        tip.innerHTML = `<div class="tt">${x.n}</div><div class="tr"><i class="b${x.c}"></i><span>${x.r}</span><b>${money(x.v)}</b></div><div class="sum"><span>占比</span><b>${pct(x.v / tot, 1)}</b></div>`;
        tip.hidden = false;
      });
      el.addEventListener('mousemove', placeTip);
      el.addEventListener('mouseleave', () => { tip.hidden = true; });
    });
  }

  function progress({ t, sub, used, cap, rc, rcCap, done, status, extra = '' }) {
    return `<div class="pg"><div class="pg-h"><span class="t">${t}${sub ? `<small>${sub}</small>` : ''}</span>${status || ''}</div>
      <div class="bar ${done ? 'done' : ''}"><i data-w="${Math.min(100, Math.max(0, (cap ? used / cap : 0) * 100))}"></i></div>
      <div class="pg-f"><span>已用 <b>${money(used)}</b> / ${int(cap)}</span><span>RC <b>${money(rc)}</b> / ${int(rcCap)}</span></div>${extra}</div>`;
  }

  /** 「全部」时每张卡单独一段，标题为卡号 */
  function perCard(fn) {
    if (!isAll()) return fn(unitOf(ui.card));
    return units.map((u) => `<h4 class="card-sec">尾号 ${esc(u.card)}</h4>${fn(u)}`).join('');
  }

  function renderProgress() {
    $('#progress').innerHTML = perCard(progressOf);
    applyWidths($('#progress'));
  }
  function progressOf(u) {
    const s = u.sum, p = s.p, w = s.wel;
    const cur = s.months[s.months.length - 1];
    const dots = Array.from({ length: p.W_QR_MAX }, (_, i) => `<i class="${i < w.times ? 'on' : ''}"></i>`).join('');
    const estIssue = !(u.params.issue || data.settings?.issue);
    const items = [
      { t: '② Pulse 特别奖赏', sub: `${p.MOB_START} ~ ${p.MOB_END}`, used: s.mobAmt, cap: p.MOB_CAP, rc: s.mob, rcCap: Core.xround(p.MOB_CAP * p.MOB_RATE), done: s.mobAmt >= p.MOB_CAP },
      { t: '③ 赏世界', sub: p.WORLD_REG ? `登记日 ${p.WORLD_REG}` : `${p.WORLD_START} ~ ${p.WORLD_END}`, used: s.worldAmt, cap: p.WORLD_CAP, rc: s.world, rcCap: p.WORLD_RC_CAP, done: s.worldAmt >= p.WORLD_CAP },
    ];
    if (cur) {
      items.push({
        t: '④ 内地餐饮', sub: `${cur.m} · 内地消费门槛`, used: cur.rh, cap: p.RH_THR, rc: cur.bonus, rcCap: p.RH_CAP, done: cur.reach,
        status: cur.reach ? '<span class="pill ok">✔ 已达标</span>' : `<span class="pill no">✘ 还差 ${money(cur.gap)}</span>`,
        extra: `<div class="pg-f"><span>本月餐饮 ${money(cur.dining)}${cur.reach ? '' : `，达标后可得 ${cur.potential}`}</span><span>${cur.toCap > 0 ? `餐饮再刷 ${money(cur.toCap)} 封顶` : '已封顶'}</span></div>`,
      });
    }
    items.push({
      t: '⑤ 迎新礼', sub: `${w.issue || '?'} ~ ${w.end || '?'} · 剩 ${w.daysLeft} 天${estIssue ? '（发卡日为估算）' : ''}`,
      used: w.spend, cap: p.W_THR, rc: w.reward, rcCap: w.max, done: w.reached,
      status: w.reached ? '<span class="pill ok">✔ 已达标</span>' : `<span class="pill no">✘ 还差 ${money(p.W_THR - w.spend)}</span>`,
      extra: `<div class="pg-f"><span>${w.invite ? `QR ≥ ${p.W_QR_MIN}：${w.count} 笔，计 ${w.times}/${p.W_QR_MAX} 次` : '未填写邀请码，无 QR 每笔奖赏'}</span><span>${w.reached ? '' : `达标后可得 ${int(w.potential)}`}</span></div>${w.invite ? `<div class="dots" aria-hidden="true">${dots}</div>` : ''}`,
    });
    return items.map(progress).join('');
  }

  function renderMonths() {
    $('#months').innerHTML = perCard((u) => `<div class="months">${monthsOf(u)}</div>`);
    applyWidths($('#months'));
  }
  function monthsOf(u) {
    const p = u.sum.p;
    return u.sum.months.map((x) => {
      const frac = Math.min(1, x.rh / p.RH_THR);
      return `<div class="month">
        <div class="row"><span class="m">${x.m}</span>${x.reach ? `<span class="pill ok">✔ 已达标 · 餐饮返利 ${x.bonus}</span>` : `<span class="pill no">✘ 未达标 · 还差 ${money(x.gap)}</span>`}</div>
        <div class="bar ${x.reach ? 'done' : ''}"><i data-w="${frac * 100}"></i></div>
        <div class="kv">
          <span>内地签账 <b>${money(x.rh)}</b> / ${int(p.RH_THR)}</span>
          <span>合资格餐饮 <b>${money(x.dining)}</b></span>
          <span>${x.reach ? '餐饮返利' : '达标后可得'} <b>${x.potential}</b> / ${p.RH_CAP}</span>
          <span>${x.toCap > 0 ? `餐饮再刷 <b>${money(x.toCap)}</b> 封顶` : '<b>已封顶</b>'}</span>
          <span>当月逐笔 RC <b>${money(x.rc)}</b></span>
        </div></div>`;
    }).join('') || '<p class="muted">无数据</p>';
  }

  function renderCats() {
    const m = new Map();
    for (const r of rows) {
      if (r.isCredit || r.channel === 'PAYMENT') continue;
      const k = r.mcc;
      if (!m.has(k)) m.set(k, { name: r.mccName.replace(/^餐饮 - /, ''), dining: r.dining === '是', v: 0, n: 0 });
      const o = m.get(k); o.v += r.net; o.n += 1;
    }
    let list = [...m.values()].filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
    if (list.length > 9) {
      const rest = list.slice(8);
      list = list.slice(0, 8).concat({ name: `其他 ${rest.length} 类`, v: rest.reduce((a, x) => a + x.v, 0), n: rest.reduce((a, x) => a + x.n, 0) });
    }
    const max = list[0]?.v || 1;
    $('#cats').innerHTML = list.map((x) => `<div class="hb"><span class="n" title="${esc(x.name)}">${esc(x.name)}<em>${x.n} 笔</em></span><span class="track"><i class="${x.dining ? 'dining' : ''}" data-w="${(x.v / max) * 100}"></i></span><span class="v">${money(x.v)}</span></div>`).join('')
      + '<div class="legend small"><span><i class="b1"></i>非餐饮</span><span><i class="b4"></i>餐饮</span></div>';
    applyWidths($('#cats'));
  }

  // ---- 每日消费：堆叠柱状图（SVG） ----
  const SERIES = [
    { k: 'SALES', n: 'SALES', c: 1 },
    { k: 'QR', n: 'QR', c: 2 },
    { k: 'APPLEPAY', n: 'Apple Pay', c: 3 },
    { k: 'GOOGLEPAY', n: 'Google Pay', c: 4 },
    { k: 'SAMSUNGPAY', n: 'Samsung Pay', c: 5 },
    { k: 'OTHER', n: '其他', c: 0 },
  ];
  function renderDaily() {
    const mode = ui.dailyMode;
    const by = new Map();
    for (const r of rows) {
      if (r.isCredit || r.channel === 'PAYMENT') continue;
      const d = mode === 'post' ? r.postDate : r.date;
      if (!d) continue;
      if (!by.has(d)) by.set(d, { QR: 0, APPLEPAY: 0, GOOGLEPAY: 0, SAMSUNGPAY: 0, SALES: 0, OTHER: 0, n: 0 });
      const o = by.get(d);
      o[SERIES.some((s) => s.k === r.channel) ? r.channel : 'OTHER'] += r.absAmount;
      o.n += 1;
    }
    const keys = [...by.keys()].sort();
    const host = $('#daily');
    const used = SERIES.filter((s) => keys.some((k) => by.get(k)[s.k] > 0));
    $('#daily-legend').innerHTML = used.map((s) => `<span><i class="b${s.c}"></i>${s.n}</span>`).join('')
      + (mode === 'post' ? '<span class="muted">未入账的交易不显示</span>' : '');
    if (!keys.length) { host.innerHTML = '<p class="muted">无数据</p>'; return; }
    // 连续日期
    const days = [];
    for (let d = keys[0]; d <= keys[keys.length - 1]; d = Core.addDays(d, 1)) days.push(d);
    const W = Math.max(320, host.clientWidth || 800), H = 240;
    const m = { l: 48, r: 8, t: 10, b: 26 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const totals = days.map((d) => (by.has(d) ? SERIES.reduce((a, s) => a + by.get(d)[s.k], 0) : 0));
    const maxV = niceMax(Math.max(...totals, 1));
    const y = (v) => m.t + ih - (v / maxV) * ih;
    const band = iw / days.length;
    const bw = Math.max(2, Math.min(28, band * 0.72));
    const ticks = 4;
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="每日消费堆叠柱状图">`;
    for (let i = 0; i <= ticks; i++) {
      const v = (maxV / ticks) * i, yy = y(v);
      svg += `<line class="${i === 0 ? 'baseline' : 'gridline'}" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/>`;
      svg += `<text class="axis" x="${m.l - 6}" y="${yy + 4}" text-anchor="end">${int(v)}</text>`;
    }
    const every = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(iw / 52))));
    days.forEach((d, i) => {
      const cx = m.l + band * i + band / 2;
      if (i % every === 0) svg += `<text class="axis" x="${cx}" y="${H - 8}" text-anchor="middle">${md(d)}</text>`;
      const o = by.get(d);
      if (!o) return;
      let acc = 0;
      const segs = SERIES.filter((s) => o[s.k] > 0);
      segs.forEach((s, j) => {
        const v = o[s.k];
        const y0 = y(acc), y1 = y(acc + v);
        acc += v;
        const top = j === segs.length - 1;
        const gap = j > 0 ? 2 : 0; // 段间 2px 间隙
        const h = Math.max(0, y0 - y1 - gap);
        if (h <= 0) return;
        const x = cx - bw / 2;
        if (top) {
          const r = Math.min(4, bw / 2, h);
          svg += `<path class="f${s.c}" d="M${x},${y0 - gap} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + bw - r} Q${x + bw},${y1} ${x + bw},${y1 + r} V${y0 - gap} Z"/>`;
        } else {
          svg += `<rect class="f${s.c}" x="${x}" y="${y1}" width="${bw}" height="${h}"/>`;
        }
      });
    });
    days.forEach((d, i) => {
      if (!by.has(d)) return;
      svg += `<rect class="hit" data-d="${d}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih}"/>`;
    });
    svg += '</svg>';
    host.innerHTML = svg;
    const tip = $('#tip');
    $$('.hit', host).forEach((el) => {
      el.addEventListener('mouseenter', () => {
        const d = el.dataset.d, o = by.get(d);
        const tot = SERIES.reduce((a, s) => a + o[s.k], 0);
        tip.innerHTML = `<div class="tt">${d}（${mode === 'post' ? '入账' : '交易'}）</div>`
          + SERIES.filter((s) => o[s.k] > 0).map((s) => `<div class="tr"><i class="b${s.c}"></i><span>${s.n}</span><b>${money(o[s.k])}</b></div>`).join('')
          + `<div class="sum"><span>${o.n} 笔</span><b>${money(tot)}</b></div>`;
        tip.hidden = false;
        el.classList.add('on');
      });
      el.addEventListener('mousemove', (e) => placeTip(e));
      el.addEventListener('mouseleave', () => { tip.hidden = true; el.classList.remove('on'); });
    });
  }
  function placeTip(e) {
    const tip = $('#tip');
    const pad = 12, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = e.clientX + pad, yy = e.clientY + pad;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
    if (yy + h > window.innerHeight - 8) yy = e.clientY - h - pad;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, yy)}px`;
  }
  function niceMax(v) {
    const p = 10 ** Math.floor(Math.log10(v));
    for (const k of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (k * p >= v) return k * p;
    return 10 * p;
  }

  // ---- 交易明细 ----
  function renderTx() {
    const months = [...new Set(rows.map((r) => r.date.slice(0, 7)))].sort();
    const sel = $('#f-month');
    sel.innerHTML = `<option value="">全部月份</option>${months.map((m) => `<option value="${m}" ${ui.f.month === m ? 'selected' : ''}>${m}</option>`).join('')}`;
    const f = ui.f, q = f.q.trim().toLowerCase();
    const list = rows.filter((r) => {
      if (f.ch && r.channel !== f.ch) return false;
      if (f.month && !r.date.startsWith(f.month)) return false;
      if (f.dining && r.dining !== '是') return false;
      if (f.noelig && r.elig !== '否') return false;
      if (q && !`${r.desc} ${r.merchant} ${r.authCode} ${r.mcc} ${r.mccName} ${r.notes.join(' ')}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const tot = (k) => list.reduce((a, r) => a + r[k], 0);
    const head = ['交易日期', '入账日期', '卡', '交易详情', '金额', '授权码', 'MCC', '商户类型', '餐饮', '计返利', '①基础', '②Pulse特别', '③赏世界', 'RC 合计', '备注'];
    const body = list.map((r) => {
      const d = defaults.get(r.id) || {};
      const eligChanged = r.elig !== d.elig && !r.refundOfId;
      const diningChanged = r.dining !== d.dining;
      const canToggle = !r.isCredit && r.channel !== 'PAYMENT';
      return `<tr class="${r.elig === '否' ? 'dim' : ''}">
        <td>${r.date}</td><td>${r.postDate || '<span class="muted">未入账</span>'}</td><td>${esc(r.card4)}</td>
        <td class="desc" title="${esc(r.desc)}"><span class="chip ${esc(r.channel)}">${esc(r.channel)}</span> ${esc(r.merchant || r.desc)}${r.city ? ` <span class="muted small">${esc(r.city)}</span>` : ''}</td>
        <td class="num ${r.amount < 0 ? 'neg' : ''}">${money(r.amount)}</td>
        <td>${esc(r.authCode)}</td><td>${esc(r.mcc)}</td><td>${esc(r.mccName)}</td>
        <td>${canToggle ? `<button type="button" class="toggle ${r.dining === '是' ? 'yes' : ''} ${diningChanged ? 'changed' : ''}" data-act="dining" data-id="${esc(r.id)}">${r.dining === '是' ? '餐饮' : '—'}</button>` : (r.dining === '是' ? '<span class="chip dining">餐饮</span>' : '')}</td>
        <td>${canToggle ? `<button type="button" class="toggle ${r.elig === '是' ? 'yes' : 'no'} ${eligChanged ? 'changed' : ''}" data-act="elig" data-id="${esc(r.id)}">${r.elig}</button>` : `<span class="muted small">${r.channel === 'PAYMENT' ? '还款' : `跟随原消费（${r.elig}）`}</span>`}</td>
        <td class="num">${r.baseRC ? money(r.baseRC) : ''}</td><td class="num">${r.mobRC ? money(r.mobRC) : ''}</td><td class="num">${r.worldRC ? money(r.worldRC) : ''}</td>
        <td class="num"><b>${r.rcTotal ? money(r.rcTotal) : ''}</b></td>
        <td class="small">${esc(r.notes.join('；'))}</td></tr>`;
    }).join('');
    $('#tbl-tx').innerHTML = `<thead><tr>${head.map((h, i) => `<th class="${[4, 10, 11, 12, 13].includes(i) ? 'num' : ''}">${h}</th>`).join('')}</tr></thead>
      <tbody>${body || `<tr><td colspan="${head.length}" class="muted">没有符合条件的交易</td></tr>`}</tbody>
      <tfoot><tr><td colspan="4">${list.length} 条</td><td class="num">${money(tot('amount'))}</td><td colspan="5"></td>
        <td class="num">${money(tot('baseRC'))}</td><td class="num">${money(tot('mobRC'))}</td><td class="num">${money(tot('worldRC'))}</td><td class="num">${money(tot('rcTotal'))}</td><td></td></tr></tfoot>`;
  }

  // ---- 按入账日对账 ----
  function renderRc() {
    const g = new Map();
    for (const r of rows) {
      if (r.channel === 'PAYMENT') continue;
      const k = r.postDate || '未入账';
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(r);
    }
    const keys = [...g.keys()].sort((a, b) => (a === '未入账') - (b === '未入账') || a.localeCompare(b));
    const S = (l, k, pred) => l.reduce((a, r) => a + (!pred || pred(r) ? r[k] : 0), 0);
    const T = { n: 0, spend: 0, ref: 0, b: 0, m: 0, w: 0, day: 0, act: 0, actDay: 0 };
    const body = keys.map((k) => {
      const l = g.get(k);
      const o = {
        n: l.length, spend: S(l, 'amount', (r) => r.amount > 0), ref: -S(l, 'amount', (r) => r.channel === 'RETURN'),
        b: S(l, 'baseRC'), m: S(l, 'mobRC'), w: S(l, 'worldRC'), din: S(l, 'rhDining'), wq: S(l, 'welQR'),
      };
      o.day = o.b + o.m + o.w;
      for (const x of ['n', 'spend', 'ref', 'b', 'm', 'w', 'day']) T[x] += o[x];
      const pending = k === '未入账';
      const act = actOf(k);
      // 「全部」：只拿填了实际到账的卡的应得来比，避免没填的卡造成假差额
      const dayAct = actuals ? o.day : S(l, 'rcTotal', (r) => { const a = unitOf(r.card4)?.actuals[k]; return a !== undefined && a !== ''; });
      if (!pending && act !== undefined && act !== '') { T.act += Number(act); T.actDay += dayAct; }
      return `<tr class="${pending ? 'dim' : ''}" data-k="${k}" data-day="${dayAct}">
        <td>${k}</td><td>${pending ? '' : stmtCell(k)}</td><td class="num">${o.n}</td>
        <td class="num">${money(o.spend)}</td><td class="num">${o.ref ? money(o.ref) : ''}</td>
        <td class="num">${money(o.b)}</td><td class="num">${money(o.m)}</td><td class="num">${money(o.w)}</td><td class="num"><b>${money(o.day)}</b></td>
        <td class="num">${pending ? '' : actuals ? `<input class="actual" type="number" step="0.01" inputmode="decimal" data-k="${k}" value="${act ?? ''}" aria-label="${k} 实际到账">` : (act ?? '')}</td>
        <td class="num diff"></td><td class="num cum"></td>
        <td class="num muted">${o.din ? money(o.din) : ''}</td><td class="num muted">${o.wq || ''}</td>
        <td class="small muted">${[...new Set(l.map((r) => md(r.date)))].join(', ')}</td></tr>`;
    }).join('');
    $('#tbl-rc').innerHTML = `<thead><tr><th>入账日期</th><th>账单日</th><th class="num">笔数</th><th class="num">消费</th><th class="num">退款</th>
      <th class="num">①基础 RC</th><th class="num">②Pulse 特别 RC</th><th class="num">③赏世界 RC</th><th class="num">当日应得</th><th class="num">实际到账</th><th class="num">差额</th><th class="num">累计差额</th>
      <th class="num">④内地餐饮签账（仅显示）</th><th class="num">⑤迎新 QR（仅显示）</th><th>交易日期</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td>合计</td><td></td><td class="num">${T.n}</td><td class="num">${money(T.spend)}</td><td class="num">${money(T.ref)}</td>
        <td class="num">${money(T.b)}</td><td class="num">${money(T.m)}</td><td class="num">${money(T.w)}</td><td class="num">${money(T.day)}</td>
        <td class="num" id="rc-act"></td><td class="num" id="rc-diff"></td><td></td><td></td><td></td><td></td></tr></tfoot>`;
    updateRcDiffs();
  }
  /** 实际到账：单卡取该卡填写的值；「全部」把各卡填写的值相加（只读） */
  function actOf(k) {
    if (actuals) return actuals[k];
    let v, any = false;
    for (const u of units) if (u.actuals[k] !== undefined && u.actuals[k] !== '') { v = (v || 0) + Number(u.actuals[k]); any = true; }
    return any ? Core.xround(v) : undefined;
  }
  function stmtCell(k) {
    if (opts) return Core.stmtDateOf(k, opts.statementDay);
    const v = [...new Set(units.map((u) => Core.stmtDateOf(k, u.opts.statementDay)))];
    return v.join(' / ');
  }
  function updateRcDiffs() {
    let cum = 0, act = 0, exp = 0, any = false;
    $$('#tbl-rc tbody tr').forEach((tr) => {
      const k = tr.dataset.k, day = Number(tr.dataset.day);
      const v = actOf(k);
      const dc = $('.diff', tr), cc = $('.cum', tr);
      if (v === undefined || v === '' || k === '未入账') { dc.textContent = ''; cc.textContent = ''; return; }
      const d = Number(v) - day;
      cum += d; act += Number(v); exp += day; any = true;
      dc.textContent = money(d); dc.className = `num diff ${d > 0.005 ? 'pos-diff' : d < -0.005 ? 'neg-diff' : ''}`;
      cc.textContent = money(cum); cc.className = `num cum ${cum > 0.005 ? 'pos-diff' : cum < -0.005 ? 'neg-diff' : ''}`;
    });
    $('#rc-act').textContent = any ? money(act) : '';
    $('#rc-diff').textContent = any ? money(act - exp) : '';
  }

  // ---- 参数 ----
  function renderParams() {
    $('#dlg-title').textContent = `参数 · 尾号 ${ui.card}`;
    const groups = [...new Set(FIELDS.map((f) => f.g))];
    $('#params').innerHTML = groups.map((g) => `<fieldset><legend>${g}</legend>${FIELDS.filter((f) => f.g === g).map((f) => {
      let v = f.k === 'stmtDay' ? opts.statementDay : f.get(cfg);
      if (f.t === 'pct') v = +(v * 100).toFixed(4);
      const changed = params[f.k] !== undefined;
      const input = f.t === 'select'
        ? `<select data-k="${f.k}">${f.o.map(([val, lab]) => `<option value="${val}" ${String(v) === val ? 'selected' : ''}>${lab}</option>`).join('')}</select>`
        : `<input data-k="${f.k}" type="${f.t === 'pct' ? 'number' : f.t}" ${f.t === 'pct' ? 'step="0.1"' : f.t === 'number' ? 'step="any"' : ''} value="${esc(v ?? '')}">`;
      return `<label>${f.l}${changed ? ' *' : ''}${input}</label>`;
    }).join('')}</fieldset>`).join('');
  }

  // ---------------- 工具 ----------------
  function applyWidths(root) {
    $$('[data-w]', root).forEach((el) => { el.style.width = `${Number(el.dataset.w).toFixed(3)}%`; });
  }

  // ---------------- 数据载入 ----------------
  function setData(payload, source) {
    const txs = (payload?.txs || []).map((t) => Core.slimTx(t));
    data = {
      txs,
      statementDay: payload.statementDay || null,
      settings: payload.settings || {},
      updatedAt: payload.updatedAt || payload.exportedAt || null,
      source,
    };
    if (source === 'file') SS.set('br:data', data);
    render();
  }

  async function importFile(file) {
    const text = await file.text();
    let payload;
    const j = JSON.parse(text);
    if (j?.log?.entries) {
      const { txs, statementDay } = Core.parseHar(text);
      payload = { txs, statementDay };
    } else if (Array.isArray(j)) payload = { txs: j };
    else if (Array.isArray(j?.txs)) payload = j;
    else if (Array.isArray(j?.transactions)) payload = { txs: j.transactions };
    else throw new Error('不认识的文件格式（支持 .har 或包含交易数组的 JSON）');
    if (!payload.txs.length) throw new Error('文件里没有找到信用卡交易记录');
    setData({ ...payload, updatedAt: new Date().toISOString() }, 'file');
  }

  function requestFromScript() { window.postMessage({ type: 'br-request' }, location.origin); }

  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || typeof e.data !== 'object') return;
    if (e.data.type !== 'br-data') return;
    bridge = true;
    if (e.data.payload && Array.isArray(e.data.payload.txs) && e.data.payload.txs.length) {
      if (data?.source === 'file') return; // 正在看导入的文件时不被覆盖
      setData(e.data.payload, 'script');
    } else if (!data) render();
  });

  // ---------------- 事件 ----------------
  function bind() {
    $('#btn-import').onclick = () => $('#file').click();
    $('#file').onchange = (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) importFile(f).catch((err) => alert(`导入失败：${err.message}`));
    };
    const drop = document.body;
    drop.addEventListener('dragover', (e) => { e.preventDefault(); $('#drop')?.classList.add('over'); });
    drop.addEventListener('dragleave', () => $('#drop')?.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault(); $('#drop')?.classList.remove('over');
      const f = e.dataTransfer?.files?.[0];
      if (f) importFile(f).catch((err) => alert(`导入失败：${err.message}`));
    });
    $('#btn-clear').onclick = () => {
      if (data?.source === 'script') {
        if (!confirm('清除油猴脚本里累计保存的全部账单？（手动修改、实际到账、参数不受影响）')) return;
        window.postMessage({ type: 'br-clear' }, location.origin);
        data = null; render();
      } else {
        SS.del('br:data'); data = null; render(); requestFromScript();
      }
    };
    $('#btn-export').onclick = () => exportExcel().catch((err) => { console.error(err); alert(`导出失败：${err.message}`); });
    $('#btn-theme').onclick = () => {
      const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      LS.set('br:theme', next);
    };

    $('#daily-mode').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      ui.dailyMode = b.dataset.v;
      $$('#daily-mode button').forEach((x) => x.classList.toggle('on', x === b));
      renderDaily();
    });
    $('#tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      ui.tab = b.dataset.tab;
      $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
      $$('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== ui.tab; });
    });
    $('#f-q').addEventListener('input', (e) => { ui.f.q = e.target.value; renderTx(); });
    $('#f-ch').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      ui.f.ch = b.dataset.v;
      $$('#f-ch button').forEach((x) => x.classList.toggle('on', x === b));
      renderTx();
    });
    $('#f-month').addEventListener('change', (e) => { ui.f.month = e.target.value; renderTx(); });
    $('#f-dining').addEventListener('change', (e) => { ui.f.dining = e.target.checked; renderTx(); });
    $('#f-noelig').addEventListener('change', (e) => { ui.f.noelig = e.target.checked; renderTx(); });
    $('#btn-reset-ovr').onclick = () => {
      if (!confirm('撤销所有对「计返利」「餐饮」的手动修改？')) return;
      overrides = { elig: {}, dining: {} }; LS.set('br:overrides', overrides); render();
    };
    $('#tbl-tx').addEventListener('click', (e) => {
      const b = e.target.closest('button.toggle'); if (!b) return;
      const id = b.dataset.id, r = rows.find((x) => x.id === id); if (!r) return;
      const d = defaults.get(id) || {};
      if (b.dataset.act === 'elig') {
        const v = r.elig === '是' ? '否' : '是';
        if (v === d.elig) delete overrides.elig[id]; else overrides.elig[id] = v;
      } else {
        const v = r.dining === '是' ? '' : '是';
        if (v === d.dining) delete overrides.dining[id]; else overrides.dining[id] = v;
      }
      LS.set('br:overrides', overrides);
      const sc = $('#tbl-tx').closest('.table-wrap').scrollTop;
      render();
      $('#tbl-tx').closest('.table-wrap').scrollTop = sc;
    });
    $('#tbl-rc').addEventListener('input', (e) => {
      const i = e.target.closest('input.actual'); if (!i) return;
      if (!actuals) return;
      if (i.value === '') delete actuals[i.dataset.k]; else actuals[i.dataset.k] = Number(i.value);
      saveActuals();
      updateRcDiffs();
    });
    $('#params').addEventListener('change', (e) => {
      const el = e.target.closest('[data-k]'); if (!el) return;
      const f = FIELDS.find((x) => x.k === el.dataset.k);
      let v = el.value;
      if (f.t === 'number') v = v === '' ? undefined : Number(v);
      if (f.t === 'pct') v = v === '' ? undefined : Number(v) / 100;
      if (!params) return;
      if (v === undefined) delete params[f.k]; else params[f.k] = v;
      saveParams();
      render();
    });
    const dlg = $('#dlg-params');
    $('#btn-params').onclick = () => { if (isAll()) return; renderParams(); dlg.showModal(); };
    $('#card-sel').addEventListener('change', (e) => {
      ui.card = e.target.value; LS.set('br:card', ui.card);
      ui.f.month = '';
      render();
    });
    $('#dlg-close').onclick = () => dlg.close();
    $('#dlg-done').onclick = () => dlg.close();
    dlg.addEventListener('click', (e) => {
      if (e.target !== dlg) return; // 只处理点在遮罩上的情况
      const r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
    });
    $('#btn-pending').onclick = () => {
      showPending = !showPending;
      LS.set('br:pending', showPending);
      renderKpis(); renderComp();
    };
    $('#btn-reset-params').onclick = () => {
      if (!params || !confirm(`恢复尾号 ${ui.card} 的所有参数为默认值？`)) return;
      paramsAll[ui.card] = {}; saveParams(); render();
    };
    let rz;
    window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (rows) renderDaily(); }, 150); });
  }

  // ---------------- 导出 Excel（与油猴脚本同一套公式表） ----------------
  async function exportExcel() {
    if (typeof ExcelJS === 'undefined') throw new Error('ExcelJS 未加载');
    // 每个卡号一个文件；选「全部」时依次导出每张卡
    const list = isAll() ? units : [unitOf(ui.card)];
    for (const u of list) {
      await exportUnit(u);
      if (list.length > 1) await new Promise((r) => setTimeout(r, 400));
    }
  }
  async function exportUnit({ card, rows, cfg, opts, actuals }) {
    const wb = await Core.buildWorkbook(ExcelJS, rows, cfg, opts);
    // 填入「实际到账」
    const ws = wb.getWorksheet('按入账日对账');
    let actSum = 0, expSum = 0, totRow = null;
    ws.eachRow((row) => {
      const a = row.getCell(1).value;
      if (a === '合计') { totRow = row; return; }
      if (!(a instanceof Date)) return;
      const k = a.toISOString().slice(0, 10);
      if (actuals[k] === undefined) return;
      const day = row.getCell('day').value?.result ?? 0;
      row.getCell('actual').value = actuals[k];
      row.getCell('diff').value = { formula: row.getCell('diff').value.formula, result: Core.xround(actuals[k] - day) };
      actSum += actuals[k]; expSum += day;
    });
    if (totRow && actSum) {
      const dayTot = totRow.getCell('day').value?.result ?? 0;
      totRow.getCell('actual').value = { formula: totRow.getCell('actual').value.formula, result: actSum };
      totRow.getCell('diff').value = { formula: totRow.getCell('diff').value.formula, result: Core.xround(actSum - dayTot) };
    }
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `信用卡账单_${card}_${today().replace(/-/g, '')}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // ---------------- 启动 ----------------
  function boot() {
    const th = LS.get('br:theme', null);
    if (th) document.documentElement.dataset.theme = th;
    if (!Core) { document.body.textContent = '核心脚本加载失败'; return; }
    bind();
    const cached = SS.get('br:data');
    if (cached?.txs?.length && cached.source === 'file') { data = cached; }
    render();
    // 向油猴脚本要数据（脚本可能晚于页面就绪，多试几次）
    requestFromScript();
    [300, 1000, 2500].forEach((ms) => setTimeout(() => { if (!bridge) requestFromScript(); else if (!data) render(); }, ms));
    setTimeout(() => { if (!data) render(); }, 2600);
  }
  boot();
})();
