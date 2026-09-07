/* Progressive enhancements for independent static pages; never rewrites content. */
(() => {
  const get = suffix => document.getElementById(`editorial-${suffix}`);
  const theme = get('theme');
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  const storageKey = 'editorial-theme';
  function applyTheme() {
    document.documentElement.dataset.theme = theme.value === 'system'
      ? (systemTheme.matches ? 'dark' : 'light') : theme.value;
  }
  try {
    const saved = localStorage.getItem(storageKey);
    theme.value = ['system', 'light', 'dark'].includes(saved) ? saved : 'system';
  } catch { theme.value = 'system'; }
  theme.addEventListener('change', () => {
    applyTheme();
    try { localStorage.setItem(storageKey, theme.value); } catch { /* Optional preference. */ }
  });
  systemTheme.addEventListener('change', applyTheme);
  applyTheme();
  get('theme-control').hidden = false;

  let toastTimer;
  function notify(message) {
    clearTimeout(toastTimer);
    const toast = get('toast');
    toast.textContent = message;
    toast.classList.add('visible');
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600);
  }
  const copyTimers = new WeakMap();
  function enableCopy(button, text, fallback) {
    const label = button.textContent;
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      clearTimeout(copyTimers.get(button));
      try {
        await navigator.clipboard.writeText(text());
        button.textContent = '已复制 ✓';
        notify('已复制');
        copyTimers.set(button, setTimeout(() => { button.textContent = label; }, 2200));
      } catch {
        button.textContent = label;
        fallback();
      } finally { button.disabled = false; }
    });
    button.hidden = false;
  }
  for (const button of document.querySelectorAll('[data-copy]')) {
    const source = document.getElementById(button.dataset.copy);
    enableCopy(button, () => source.textContent, () => {
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      notify('无法自动复制，已选中文字，请手动复制');
    });
  }
  for (const button of document.querySelectorAll('[data-copy-link]')) {
    enableCopy(button, () => {
      const url = new URL(location.href);
      url.hash = button.dataset.copyLink;
      return url.href;
    }, () => {
      // A normal fragment navigation leaves the URL available for manual copying.
      location.hash = button.dataset.copyLink;
      notify('无法自动复制，请从地址栏复制当前章节地址');
    });
  }

  const toc = get('page-toc');
  if (toc) {
    const headings = [...toc.querySelectorAll('a')].map(link => document.getElementById(link.hash.slice(1)));
    let outlineFrame = 0;
    function updateOutline() {
      outlineFrame = 0;
      const threshold = document.querySelector('.site-header').getBoundingClientRect().bottom + 40;
      let active = headings[0];
      for (const heading of headings) if (heading.getBoundingClientRect().top <= threshold) active = heading;
      if (window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 3) active = headings.at(-1);
      for (const link of toc.querySelectorAll('a')) {
        if (active && link.hash === `#${active.id}`) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      }
    }
    window.addEventListener('scroll', () => {
      if (!outlineFrame) outlineFrame = requestAnimationFrame(updateOutline);
    }, { passive: true });
    window.addEventListener('resize', updateOutline);
    window.addEventListener('load', updateOutline);
    updateOutline();
  }

  const searchDialog = get('search-dialog');
  const menu = get('mobile-nav');
  if (typeof searchDialog.showModal !== 'function') return;
  let activeDialog;
  // Release synchronously before following links or switching dialogs. The queued
  // native close event must never restore an old position over a destination.
  function releaseDialog(state, returnFocus = true) {
    if (activeDialog !== state) return;
    activeDialog = null;
    document.body.classList.remove('modal-open');
    document.body.style.removeProperty('top');
    window.scrollTo({ left: state.left, top: state.top, behavior: 'instant' });
    if (returnFocus && state.invoker?.isConnected) state.invoker.focus({ preventScroll: true });
  }
  function closeDialog(dialog, returnFocus = true) {
    const state = activeDialog;
    dialog.close();
    if (state?.dialog === dialog) releaseDialog(state, returnFocus);
  }
  function showDialog(dialog, invoker) {
    if (activeDialog) closeDialog(activeDialog.dialog);
    const state = { dialog, invoker, left: window.scrollX, top: window.scrollY };
    activeDialog = state;
    document.body.style.top = `${-state.top}px`;
    document.body.classList.add('modal-open');
    try { dialog.showModal(); } catch (error) { releaseDialog(state); throw error; }
  }
  for (const dialog of [searchDialog, menu]) {
    dialog.addEventListener('close', () => {
      if (!dialog.open && activeDialog?.dialog === dialog) releaseDialog(activeDialog);
    });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(dialog);
    });
  }
  get('menu-toggle').addEventListener('click', () => showDialog(menu, get('menu-toggle')));
  get('close-menu').addEventListener('click', () => closeDialog(menu));
  menu.addEventListener('click', event => {
    if (event.target.closest('a')) closeDialog(menu, false);
  });
  get('menu-toggle').hidden = false;
  get('mobile-fallback').hidden = true;

  let index;
  try { index = JSON.parse(get('search-data').textContent); } catch { return; }
  const input = get('search-input');
  const results = get('search-results');
  const searchToggle = get('search-toggle');
  let activeResult = 0;
  function setActiveResult(position, scroll = true) {
    const links = [...results.querySelectorAll('a')];
    activeResult = Math.max(0, Math.min(position, links.length - 1));
    links.forEach((link, index) => link.classList.toggle('active', index === activeResult));
    get('search-active').textContent = links[activeResult]
      ? `当前选择：${links[activeResult].querySelector('strong').textContent}，第 ${activeResult + 1} 项，共 ${links.length} 项。按回车打开。` : '';
    if (scroll) links[activeResult]?.scrollIntoView({ block: 'nearest' });
  }
  function excerpt(content, tokens) {
    const lower = content.toLowerCase();
    const positions = tokens.map(token => lower.indexOf(token)).filter(position => position >= 0);
    const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 28);
    return `${start ? '…' : ''}${content.slice(start, start + 115)}${content.length > start + 115 ? '…' : ''}`;
  }
  function updateSearch() {
    const tokens = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = index.map((item, order) => ({ ...item, order }))
      .filter(item => tokens.length ? tokens.every(token => `${item.title} ${item.page} ${item.content}`.toLowerCase().includes(token)) : !item.href.includes('#'))
      .sort((a, b) => {
        const score = item => tokens.reduce((total, token) => total + (item.title.toLowerCase().includes(token) ? 20 : 0), 0);
        return score(b) - score(a) || a.order - b.order;
      });
    const visible = matches.slice(0, 16);
    get('search-count').textContent = tokens.length ? `找到 ${matches.length} 个结果${matches.length > 16 ? '，显示前 16 项' : ''}` : '页面入口';
    results.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement('p');
      empty.className = 'search-empty';
      empty.textContent = '没有找到相关内容。试试更短的关键词，或从文档目录进入。';
      results.append(empty);
    }
    for (const item of visible) {
      const link = document.createElement('a');
      link.href = item.href;
      link.className = 'search-result';
      const group = document.createElement('small'); group.textContent = item.page;
      const title = document.createElement('strong'); title.textContent = item.title;
      const summary = document.createElement('span'); summary.textContent = excerpt(item.content, tokens);
      link.append(group, title, summary);
      link.addEventListener('click', () => closeDialog(searchDialog, false));
      results.append(link);
    }
    setActiveResult(0, false);
    results.scrollTop = 0;
  }
  function openSearch(invoker) {
    if (invoker?.closest('dialog')) invoker = searchToggle;
    input.value = '';
    updateSearch();
    showDialog(searchDialog, invoker);
    input.focus({ preventScroll: true });
  }
  searchToggle.addEventListener('click', () => openSearch(searchToggle));
  get('close-search').addEventListener('click', () => closeDialog(searchDialog));
  input.addEventListener('input', updateSearch);
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); closeDialog(searchDialog); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setActiveResult(activeResult + (event.key === 'ArrowDown' ? 1 : -1));
    }
    if (event.key === 'Enter') { event.preventDefault(); results.querySelectorAll('a')[activeResult]?.click(); }
  });
  document.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (searchDialog.open) closeDialog(searchDialog);
      else openSearch(document.activeElement);
    }
  });
  if (/Mac|iPhone|iPad/.test(navigator.platform)) searchToggle.querySelector('kbd').textContent = '⌘ K';
  searchToggle.hidden = false;
})();
