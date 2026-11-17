/* 页面导航（手机在底部、电脑在顶部）：向下滚动时收起，向上滚动或回到页面顶部时出现 */
(function () {
  'use strict';
  const nav = document.getElementById('pagenav');
  if (!nav) return;
  const TOP = 24, STEP = 8;
  let last = window.scrollY, ticking = false;
  const set = (away) => {
    nav.classList.toggle('away', away);
    // 电脑上导航在顶部：同步让顶栏上移/下移
    document.documentElement.classList.toggle('nav-away', away);
  };
  function update() {
    ticking = false;
    const y = Math.max(0, window.scrollY);
    const atBottom = window.innerHeight + y >= document.documentElement.scrollHeight - 2;
    if (y <= TOP) set(false);
    else if (y - last > STEP && !atBottom) set(true);
    else if (last - y > STEP) set(false);
    else return; // 小幅抖动不更新基准
    last = y;
  }
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  // 键盘操作时始终可见
  nav.addEventListener('focusin', () => set(false));
})();
