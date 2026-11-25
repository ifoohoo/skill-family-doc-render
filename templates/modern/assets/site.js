/* Client runtime for modern static docs: theme toggle, synced tabs, Cmd+K search, TOC scrollspy, and copy actions. */
(() => {
  const root = document.documentElement;
  root.dataset.js = 'ready';

  const get = (id) => document.getElementById(id);

  // 1. Single-icon Light/Dark theme toggle with localStorage persistence
  const themeKey = 'sf-docs-theme';
  const themeToggle = get('doc-theme-toggle');
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

  function currentEffectiveTheme() {
    if (root.dataset.theme === 'dark' || root.dataset.theme === 'light') {
      return root.dataset.theme;
    }
    return systemDark.matches ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    if (theme === 'dark' || theme === 'light') {
      root.dataset.theme = theme;
    } else {
      delete root.dataset.theme;
    }
    if (themeToggle) {
      const effective = currentEffectiveTheme();
      themeToggle.setAttribute('aria-pressed', String(effective === 'dark'));
      themeToggle.title = effective === 'dark' ? '切换至浅色模式' : '切换至深色模式';
    }
  }

  try {
    const saved = localStorage.getItem(themeKey);
    if (saved === 'light' || saved === 'dark') applyTheme(saved);
    else applyTheme(null);
  } catch {
    applyTheme(null);
  }

  systemDark.addEventListener('change', () => {
    try {
      if (!localStorage.getItem(themeKey)) applyTheme(null);
    } catch {
      applyTheme(null);
    }
  });

  if (themeToggle) {
    themeToggle.hidden = false;
    themeToggle.addEventListener('click', () => {
      const next = currentEffectiveTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try {
        localStorage.setItem(themeKey, next);
      } catch {
        /* Optional browser storage. */
      }
    });
  }

  // 2. Toast & Copy buttons
  let toastTimer;
  function notify(message) {
    const toast = get('doc-toast');
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('visible');
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 2200);
  }

  const copyTimers = new WeakMap();
  function bindCopy(button, readText, onFallback, copiedLabel = '已复制 ✓') {
    const defaultLabel = button.textContent;
    button.hidden = false;
    button.addEventListener('click', async (event) => {
      if (button.tagName === 'A') {
        event.preventDefault();
      }
      if (button.disabled || button.dataset.copyBusy === '1') return;
      button.disabled = true;
      button.dataset.copyBusy = '1';
      clearTimeout(copyTimers.get(button));
      try {
        const value = readText();
        if (button.dataset.copyLink) {
          try {
            window.history.replaceState(null, '', `#${button.dataset.copyLink}`);
          } catch {
            window.location.hash = button.dataset.copyLink;
          }
        }
        await navigator.clipboard.writeText(value);
        button.textContent = copiedLabel;
        button.classList.add('copied');
        notify('已复制到剪贴板');
        copyTimers.set(button, setTimeout(() => {
          button.textContent = defaultLabel;
          button.classList.remove('copied');
        }, 2000));
      } catch {
        button.textContent = defaultLabel;
        onFallback();
      } finally {
        button.disabled = false;
        delete button.dataset.copyBusy;
      }
    });
  }

  for (const btn of document.querySelectorAll('[data-copy]')) {
    const source = document.getElementById(btn.dataset.copy);
    if (!source) continue;
    bindCopy(btn, () => source.textContent, () => {
      const range = document.createRange();
      range.selectNodeContents(source);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      notify('已选中文本，请使用快捷键复制');
    });
  }

  for (const btn of document.querySelectorAll('[data-copy-link]')) {
    bindCopy(btn, () => {
      const url = new URL(window.location.href);
      url.hash = btn.dataset.copyLink;
      return url.href;
    }, () => {
      window.location.hash = btn.dataset.copyLink;
      notify('请从地址栏复制当前章节链接');
    }, '✓');
  }

  // 3. Global synced tabs (::: tabs sync="host")
  const tabGroups = [...document.querySelectorAll('[data-tabs]')];
  function activateTab(group, tabKey) {
    const buttons = [...group.querySelectorAll('[role="tab"]')];
    const panels = [...group.querySelectorAll('[role="tabpanel"]')];
    const target = buttons.find((b) => b.dataset.tabKey === tabKey) || buttons[0];
    if (!target) return;
    const chosenKey = target.dataset.tabKey;
    buttons.forEach((btn) => {
      const selected = btn.dataset.tabKey === chosenKey;
      btn.setAttribute('aria-selected', String(selected));
      btn.tabIndex = selected ? 0 : -1;
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.tabKey !== chosenKey;
    });
  }

  for (const group of tabGroups) {
    const syncId = group.dataset.sync;
    if (syncId) {
      try {
        const stored = localStorage.getItem(`sf-docs-tab:${syncId}`);
        if (stored) activateTab(group, stored);
      } catch {
        /* Optional storage. */
      }
    }
    const buttons = [...group.querySelectorAll('[role="tab"]')];
    buttons.forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.tabKey;
        activateTab(group, key);
        if (syncId) {
          try {
            localStorage.setItem(`sf-docs-tab:${syncId}`, key);
          } catch {
            /* Optional storage. */
          }
          for (const peer of tabGroups) {
            if (peer !== group && peer.dataset.sync === syncId) {
              activateTab(peer, key);
            }
          }
        }
      });
      btn.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        let nextIdx = idx;
        if (event.key === 'ArrowRight') nextIdx = (idx + 1) % buttons.length;
        else if (event.key === 'ArrowLeft') nextIdx = (idx - 1 + buttons.length) % buttons.length;
        else if (event.key === 'Home') nextIdx = 0;
        else if (event.key === 'End') nextIdx = buttons.length - 1;
        buttons[nextIdx]?.focus();
        buttons[nextIdx]?.click();
      });
    });
  }

  // 4. Right TOC Scrollspy (viewport-top geometry + bottom-of-page activation)
  const toc = get('doc-page-toc');
  if (toc) {
    const links = [...toc.querySelectorAll('a')];
    const items = links
      .map((link) => ({ link, heading: document.getElementById(link.hash.slice(1)) }))
      .filter((item) => item.heading);

    function setActiveHeading(id) {
      for (const { link } of items) {
        if (link.hash === `#${id}`) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      }
    }

    if (items.length) {
      let rafPending = false;
      function updateScrollspy() {
        rafPending = false;
        const docEl = document.documentElement;
        const atBottom = window.scrollY > 0
          && Math.ceil(window.scrollY + window.innerHeight) >= docEl.scrollHeight - 8;
        if (atBottom) {
          for (let i = items.length - 1; i >= 0; i -= 1) {
            const rect = items[i].heading.getBoundingClientRect();
            if (rect.top <= window.innerHeight - 40) {
              setActiveHeading(items[i].heading.id);
              return;
            }
          }
        }
        let chosen = items[0].heading.id;
        for (let i = items.length - 1; i >= 0; i -= 1) {
          if (items[i].heading.getBoundingClientRect().top <= 120) {
            chosen = items[i].heading.id;
            break;
          }
        }
        setActiveHeading(chosen);
      }

      function requestScrollspy() {
        if (rafPending) return;
        rafPending = true;
        window.requestAnimationFrame(updateScrollspy);
      }

      updateScrollspy();
      window.addEventListener('scroll', requestScrollspy, { passive: true });
      window.addEventListener('resize', requestScrollspy, { passive: true });
      window.addEventListener('hashchange', () => {
        const targetId = window.location.hash.slice(1);
        if (items.some((item) => item.heading.id === targetId)) {
          setActiveHeading(targetId);
        } else {
          requestScrollspy();
        }
      });
    }
  }

  // 5. Dialog helpers (Mobile Nav, Search, Diagram Lightbox)
  const searchDialog = get('doc-search-dialog');
  const mobileDialog = get('doc-mobile-nav');
  const diagramDialog = get('doc-diagram-dialog');
  const menuToggle = get('doc-menu-toggle');
  const searchToggle = get('doc-search-toggle');

  if (typeof HTMLDialogElement === 'function') {
    let activeState = null;

    function openModal(dialog, invoker) {
      if (!dialog) return;
      if (activeState?.dialog && activeState.dialog !== dialog) {
        activeState.dialog.close();
      }
      activeState = { dialog, invoker, scrollX: window.scrollX, scrollY: window.scrollY };
      root.classList.add('modal-open');
      document.body.classList.add('modal-open');
      dialog.showModal();
    }

    function releaseModal(dialog, returnFocus = true) {
      if (!activeState || activeState.dialog !== dialog) return;
      const state = activeState;
      activeState = null;
      root.classList.remove('modal-open');
      document.body.classList.remove('modal-open');
      window.scrollTo({ left: state.scrollX, top: state.scrollY, behavior: 'auto' });
      if (returnFocus && state.invoker?.isConnected) {
        state.invoker.focus({ preventScroll: true });
      }
    }

    for (const dialog of [searchDialog, mobileDialog, diagramDialog]) {
      if (!dialog) continue;
      dialog.addEventListener('close', () => releaseModal(dialog));
      dialog.addEventListener('click', (event) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        if (
          event.clientX < rect.left
          || event.clientX > rect.right
          || event.clientY < rect.top
          || event.clientY > rect.bottom
        ) {
          dialog.close();
        }
      });
    }

    if (menuToggle && mobileDialog) {
      menuToggle.hidden = false;
      menuToggle.addEventListener('click', () => openModal(mobileDialog, menuToggle));
      get('doc-close-menu')?.addEventListener('click', () => mobileDialog.close());
      mobileDialog.addEventListener('click', (event) => {
        if (event.target.closest('a')) mobileDialog.close();
      });
    }

    // 6. Diagram zoom lightbox
    const diagramDialogTitle = get('doc-diagram-dialog-title');
    const diagramDialogBody = get('doc-diagram-dialog-body');
    get('doc-close-diagram')?.addEventListener('click', () => diagramDialog?.close());

    for (const btn of document.querySelectorAll('[data-diagram-expand]')) {
      btn.hidden = false;
      btn.addEventListener('click', () => {
        if (!diagramDialog || !diagramDialogBody) return;
        const kind = btn.dataset.diagramKind || 'svg';
        const src = btn.dataset.diagramExpand;
        const title = btn.dataset.diagramTitle || '图表预览';
        if (diagramDialogTitle) diagramDialogTitle.textContent = title;
        diagramDialogBody.replaceChildren();
        if (kind === 'html') {
          const frame = document.createElement('iframe');
          frame.src = src;
          frame.title = title;
          frame.sandbox = 'allow-scripts';
          frame.style.width = '100%';
          frame.style.height = '76vh';
          frame.style.border = '0';
          diagramDialogBody.append(frame);
        } else {
          const img = document.createElement('img');
          img.src = src;
          img.alt = title;
          img.style.width = '100%';
          img.style.height = 'auto';
          diagramDialogBody.append(img);
        }
        openModal(diagramDialog, btn);
      });
    }

    // 7. Cmd+K / Ctrl+K Full-Text Search (reads data-search-index with ?v=<sha8>!)
    if (searchToggle && searchDialog) {
      const searchInput = get('doc-search-input');
      const searchResults = get('doc-search-results');
      const searchCount = get('doc-search-count');
      const searchActive = get('doc-search-active');
      const closeSearch = get('doc-close-search');
      let searchIndexCache = null;
      let activeIndex = 0;

      if (/Mac|iPhone|iPad/i.test(navigator.platform || '')) {
        const kbd = searchToggle.querySelector('kbd');
        if (kbd) kbd.textContent = '⌘K';
      }
      searchToggle.hidden = false;

      function fallbackSidebarIndex() {
        return [...document.querySelectorAll('#doc-desktop-nav .nav-link')].map((a) => ({
          title: a.textContent.trim(),
          page: a.textContent.trim(),
          href: a.getAttribute('href') || 'index.html',
          content: '',
        }));
      }

      async function loadSearchIndex() {
        if (searchIndexCache) return searchIndexCache;
        const url = root.dataset.searchIndex;
        if (!url) {
          searchIndexCache = fallbackSidebarIndex();
          return searchIndexCache;
        }
        try {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          searchIndexCache = await response.json();
        } catch {
          searchIndexCache = fallbackSidebarIndex();
        }
        return searchIndexCache;
      }

      function escapeRegExp(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }

      function appendHighlighted(container, text, tokens) {
        if (!text) return;
        const unique = [...new Set(tokens.filter(Boolean))].sort((a, b) => b.length - a.length);
        if (!unique.length) {
          container.textContent = text;
          return;
        }
        const re = new RegExp(`(${unique.map(escapeRegExp).join('|')})`, 'gi');
        let lastIndex = 0;
        let match;
        while ((match = re.exec(text)) !== null) {
          if (match.index > lastIndex) {
            container.append(document.createTextNode(text.slice(lastIndex, match.index)));
          }
          const mark = document.createElement('mark');
          mark.textContent = match[0];
          container.append(mark);
          lastIndex = match.index + match[0].length;
          if (match[0].length === 0) re.lastIndex += 1;
        }
        if (lastIndex < text.length) {
          container.append(document.createTextNode(text.slice(lastIndex)));
        }
      }

      function buildExcerpt(text, tokens, windowLen = 104) {
        if (!text) return '';
        if (!tokens.length) {
          return text.length > windowLen ? `${text.slice(0, windowLen)}…` : text;
        }
        const lower = text.toLowerCase();
        const candidates = [];
        for (const tok of tokens) {
          let from = 0;
          while (from < lower.length) {
            const idx = lower.indexOf(tok, from);
            if (idx < 0) break;
            candidates.push(idx);
            from = idx + Math.max(1, tok.length);
          }
        }
        let bestAnchor = candidates[0] ?? 0;
        let bestHits = -1;
        for (const pos of candidates) {
          const winStart = Math.max(0, pos - 24);
          const winSlice = lower.slice(winStart, winStart + windowLen);
          const hitCount = tokens.reduce((acc, tok) => acc + (winSlice.includes(tok) ? 1 : 0), 0);
          if (hitCount > bestHits) {
            bestHits = hitCount;
            bestAnchor = pos;
          }
        }
        const start = Math.max(0, bestAnchor - 26);
        const slice = text.slice(start, start + windowLen).trim();
        return `${start > 0 ? '…' : ''}${slice}${text.length > start + windowLen ? '…' : ''}`;
      }

      function setActiveResult(pos, scroll = true) {
        const links = [...searchResults.querySelectorAll('a')];
        if (!links.length) {
          activeIndex = 0;
          if (searchActive) searchActive.textContent = '';
          return;
        }
        activeIndex = Math.max(0, Math.min(pos, links.length - 1));
        links.forEach((el, idx) => el.classList.toggle('active', idx === activeIndex));
        if (searchActive) {
          searchActive.textContent = `已选中第 ${activeIndex + 1} 项，共 ${links.length} 项`;
        }
        if (scroll) links[activeIndex]?.scrollIntoView({ block: 'nearest' });
      }

      function hitCoreSignature(text, tokens) {
        if (!text || !tokens.length) return '';
        const lower = text.toLowerCase();
        const positions = tokens.map((tok) => lower.indexOf(tok)).filter((pos) => pos >= 0);
        if (!positions.length) return '';
        const anchor = Math.min(...positions);
        return lower.slice(Math.max(0, anchor - 16), anchor + 36).replace(/\s+/g, ' ').trim();
      }

      function renderSearchResults(entries) {
        const tokens = searchInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const rawMatches = entries
          .map((item, order) => ({ ...item, order }))
          .filter((item) => (tokens.length
            ? tokens.every((tok) => `${item.title} ${item.page} ${item.content}`.toLowerCase().includes(tok))
            : !item.href.includes('#')));

        // 优先按具体度排序（深层子章节先于外层大节与整页容器），折叠同页同一命中点的重复包裹条目
        const specificity = (item) => {
          if (!item.href.includes('#')) return 0;
          return 2 - Math.min(1, (item.content || '').length / 600);
        };
        const sortedForDedup = [...rawMatches].sort((a, b) => specificity(b) - specificity(a) || a.order - b.order);
        const seenPageCores = new Map();
        const deduped = [];
        for (const item of sortedForDedup) {
          if (!tokens.length) {
            deduped.push(item);
            continue;
          }
          const pageHref = item.href.split('#')[0];
          const titleOrSummaryHit = tokens.some((tok) => (
            item.title.toLowerCase().includes(tok)
            || (item.summary && item.summary.toLowerCase().includes(tok))
          ));
          const core = hitCoreSignature(item.content, tokens);
          if (!seenPageCores.has(pageHref)) seenPageCores.set(pageHref, new Set());
          const pageSet = seenPageCores.get(pageHref);
          if (!titleOrSummaryHit && core && pageSet.has(core)) {
            continue;
          }
          if (core) pageSet.add(core);
          deduped.push(item);
        }

        const matches = deduped.sort((a, b) => {
          const score = (item) => tokens.reduce((acc, tok) => {
            const titleHit = item.title.toLowerCase().includes(tok) ? 30 : 0;
            const summaryHit = item.summary && item.summary.toLowerCase().includes(tok) ? 10 : 0;
            const sectionBonus = item.href.includes('#') ? 6 : 0;
            const pageHit = item.page.toLowerCase().includes(tok) ? 3 : 0;
            return acc + titleHit + summaryHit + sectionBonus + pageHit;
          }, 0);
          return score(b) - score(a) || a.order - b.order;
        });
        const visible = matches.slice(0, 16);
        searchCount.textContent = tokens.length
          ? `找到 ${matches.length} 个匹配项${matches.length > 16 ? '（显示前 16 项）' : ''}`
          : '全部页面入口';
        searchResults.replaceChildren();
        if (!visible.length) {
          const empty = document.createElement('p');
          empty.className = 'search-empty';
          empty.textContent = '未找到匹配内容，请尝试换用更短的关键词。';
          searchResults.append(empty);
          setActiveResult(0, false);
          return;
        }
        for (const item of visible) {
          const a = document.createElement('a');
          a.className = 'search-result';
          a.href = item.href;
          const small = document.createElement('small');
          small.textContent = item.href.includes('#') ? `${item.page} · 章节` : item.page;
          const strong = document.createElement('strong');
          appendHighlighted(strong, item.title, tokens);
          const span = document.createElement('span');
          let excerpt = '';
          if (!tokens.length) {
            excerpt = item.summary || buildExcerpt(item.content, []);
          } else if (!item.href.includes('#') && item.summary && tokens.some((tok) => item.summary.toLowerCase().includes(tok))) {
            excerpt = buildExcerpt(item.summary, tokens);
          } else {
            excerpt = buildExcerpt(item.content, tokens);
          }
          appendHighlighted(span, excerpt, tokens);
          a.append(small, strong, span);
          a.addEventListener('click', () => searchDialog.close());
          searchResults.append(a);
        }
        setActiveResult(0, false);
        searchResults.scrollTop = 0;
      }

      async function openSearch(invoker) {
        if (invoker?.closest?.('dialog')) invoker = searchToggle;
        searchInput.value = '';
        openModal(searchDialog, invoker);
        searchInput.focus({ preventScroll: true });
        const entries = await loadSearchIndex();
        renderSearchResults(entries);
      }

      searchToggle.addEventListener('click', () => openSearch(searchToggle));
      closeSearch?.addEventListener('click', () => searchDialog.close());
      searchInput.addEventListener('input', async () => {
        const entries = await loadSearchIndex();
        renderSearchResults(entries);
      });
      searchInput.addEventListener('keydown', (event) => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          searchDialog.close();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setActiveResult(activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
        } else if (event.key === 'Enter') {
          event.preventDefault();
          searchResults.querySelectorAll('a')[activeIndex]?.click();
        }
      });

      document.addEventListener('keydown', (event) => {
        if (event.isComposing || event.keyCode === 229) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          if (searchDialog.open) searchDialog.close();
          else openSearch(document.activeElement);
        }
      });
    }
  }
})();
