/* 不含看板逻辑的页面共用：沿用看板保存的深色/浅色选择，并提供切换按钮 */
(function () {
  'use strict';
  const KEY = 'br:theme';
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } };
  const th = read();
  if (th === 'dark' || th === 'light') document.documentElement.dataset.theme = th;
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.getElementById('btn-theme');
    if (!b) return;
    b.addEventListener('click', () => {
      const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) { /* ignore */ }
    });
  });
})();
