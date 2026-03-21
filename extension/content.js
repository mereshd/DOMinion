// DOMinion Content Script
// Inline article annotations with tooltips, chat, and persistence

(function() {
  'use strict';

  // ============================================================
  // Constants
  // ============================================================
  const ANNOTATION_META = {
    'fact-check': { icon: '\u{1F50D}', label: 'Fact-check',      color: '#FF6B6B' },
    'jargon':     { icon: '\u{1F4D6}', label: 'Explanation',     color: '#C4B5FD' },
    'source':     { icon: '\u{1F517}', label: 'Source Analysis',  color: '#F9E547' },
    'context':    { icon: '\u{2795}',  label: 'Missing Context',  color: '#C4B5FD' }
  };

  const TRACKING_PARAMS = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'fbclid', 'gclid', 'ref', 'mc_cid', 'mc_eid'
  ];

  // ============================================================
  // State
  // ============================================================
  let annotations = [];
  let dismissedIds = new Set();
  let articleContent = null;
  let isAnalyzing = false;
  let highlightElements = [];

  // Overlay UI (shadow DOM)
  let overlayContainer = null;
  let overlayShadow = null;
  let tooltipEl = null;
  let chatPanelEl = null;
  let statusBannerEl = null;

  // Tooltip
  let tooltipHideTimer = null;

  // Selection context menu
  let selectionMenuEl = null;
  let savedSelectionRange = null;
  let isSelectionAnalyzing = false;

  // TOC sidebar
  let tocEl = null;
  let isTocMinimized = false;

  // Chat
  let currentChatAnnotation = null;
  let chatConversationHistory = [];
  let isChatProcessing = false;

  // ============================================================
  // Persistence — keyed by normalized URL
  // ============================================================
  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      TRACKING_PARAMS.forEach(p => u.searchParams.delete(p));
      return u.toString();
    } catch { return url; }
  }

  function getStorageKey() {
    return 'an:' + normalizeUrl(window.location.href);
  }

  function generateId() {
    return 'a' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }

  async function saveToCache() {
    const key = getStorageKey();
    await chrome.storage.local.set({
      [key]: {
        url: window.location.href,
        title: document.title,
        savedAt: Date.now(),
        articleMarkdown: articleContent ? articleContent.markdown : '',
        annotations: annotations,
        dismissedIds: [...dismissedIds]
      }
    });
  }

  async function loadFromCache() {
    const key = getStorageKey();
    const result = await chrome.storage.local.get(key);
    return result[key] || null;
  }

  async function clearCache() {
    const key = getStorageKey();
    await chrome.storage.local.remove(key);
  }

  async function restoreFromCache() {
    try {
      const cached = await loadFromCache();
      if (!cached || !cached.annotations || cached.annotations.length === 0) return;

      if (!overlayContainer) createOverlay();

      dismissedIds = new Set(cached.dismissedIds || []);
      annotations = cached.annotations.filter(a => a && a.id && !dismissedIds.has(a.id));

      if (cached.articleMarkdown) {
        articleContent = {
          title: cached.title || document.title,
          url: window.location.href,
          markdown: cached.articleMarkdown
        };
      }

      if (annotations.length > 0) {
        highlightAnnotations();
        buildToc();
      }
    } catch (e) {
      console.warn('DOMinion: failed to restore cache', e);
    }
  }

  // ============================================================
  // Message Listener
  // ============================================================
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'analyzeArticle') {
      analyzeArticle();
      sendResponse({ success: true });
    } else if (message.action === 'clearAnnotations') {
      clearAllAnnotations();
      sendResponse({ success: true });
    }
    return true;
  });

  // ============================================================
  // Article Extraction (HTML → Markdown via Turndown)
  // ============================================================
  function getArticleContainer() {
    const selectors = [
      'article', '[role="article"]', 'main article', 'main',
      '[role="main"]', '.post-content', '.article-content',
      '.entry-content', '.content', '#content', '.post', '.article'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 500) return el;
    }
    return document.body;
  }

  function extractArticleContent() {
    const contentElement = getArticleContainer();
    const clone = contentElement.cloneNode(true);

    const removeSelectors = [
      'nav', 'header', 'footer', 'aside',
      '.sidebar', '.navigation', '.menu', '.ads', '.advertisement',
      '.comments', '.comment', '.social-share', '.related-posts',
      'script', 'style', 'noscript', 'iframe', 'svg',
      '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
      '.cookie-banner', '.newsletter-signup', '.popup'
    ];

    removeSelectors.forEach(sel => {
      clone.querySelectorAll(sel).forEach(el => el.remove());
    });

    const turndownService = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      emDelimiter: '*'
    });

    if (typeof turndownPluginGfm !== 'undefined') {
      turndownService.use(turndownPluginGfm.gfm);
    }

    turndownService.addRule('removeHiddenElements', {
      filter: function(node) {
        const style = window.getComputedStyle(node);
        return style.display === 'none' || style.visibility === 'hidden';
      },
      replacement: () => ''
    });

    turndownService.addRule('images', {
      filter: 'img',
      replacement: function(content, node) {
        const alt = node.alt || 'image';
        const src = node.src || '';
        if (!src || src.startsWith('data:')) return '';
        return `![${alt}](${src})`;
      }
    });

    return {
      title: document.title,
      url: window.location.href,
      markdown: turndownService.turndown(clone).trim()
    };
  }

  // ============================================================
  // Analysis Flow
  // ============================================================
  async function analyzeArticle() {
    if (isAnalyzing) return;
    isAnalyzing = true;

    clearHighlights();
    dismissedIds = new Set();
    if (!overlayContainer) createOverlay();

    showStatus('Analyzing article\u2026');

    try {
      articleContent = extractArticleContent();

      const result = await chrome.storage.sync.get(['geminiApiKey', 'geminiModel']);
      if (!result.geminiApiKey) {
        showStatus('Please set your API key in the extension popup.', true);
        isAnalyzing = false;
        return;
      }

      const response = await chrome.runtime.sendMessage({
        action: 'analyze',
        apiKey: result.geminiApiKey,
        model: result.geminiModel || 'gemini-3.1-flash-lite-preview',
        articleContent: articleContent.markdown,
        articleTitle: articleContent.title
      });

      if (response.error) {
        showStatus('Error: ' + response.error, true);
        isAnalyzing = false;
        return;
      }

      annotations = response.annotations;
      annotations.forEach(ann => {
        ann.id = generateId();
        ann.source = 'auto';
        ann.chatHistory = ann.chatHistory || [];
      });

      highlightAnnotations();
      buildToc();
      await saveToCache();

      const placed = highlightElements.length;
      showStatus(
        placed > 0
          ? '\u2713 ' + placed + ' annotation' + (placed !== 1 ? 's' : '') + ' added'
          : 'Could not place annotations in this page',
        placed === 0,
        3000
      );

    } catch (error) {
      showStatus('Error: ' + error.message, true);
    }

    isAnalyzing = false;
  }

  // ============================================================
  // DOM Highlighting
  // ============================================================
  function highlightAnnotations() {
    const container = getArticleContainer();
    if (!container) return;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let fullText = '';
    while (walker.nextNode()) fullText += walker.currentNode.textContent;

    const positioned = annotations.map(ann => {
      let pos = fullText.indexOf(ann.quote);
      if (pos === -1) pos = fullText.toLowerCase().indexOf(ann.quote.toLowerCase());
      return { annotation: ann, position: pos };
    }).filter(p => p.position !== -1);

    positioned.sort((a, b) => b.position - a.position);

    const highlightedIds = new Set();
    for (const { annotation } of positioned) {
      const mark = findAndHighlight(container, annotation.quote, annotation.id, annotation.type);
      if (mark) {
        highlightElements.push(mark);
        attachHighlightListeners(mark, annotation);
        highlightedIds.add(annotation.id);
      }
    }

    annotations = annotations.filter(a => highlightedIds.has(a.id));
  }

  function findAndHighlight(root, quote, id, type) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    let fullText = '';
    const nodeMap = textNodes.map(node => {
      const start = fullText.length;
      fullText += node.textContent;
      return { node, start };
    });

    let matchIndex = fullText.indexOf(quote);
    if (matchIndex === -1) {
      matchIndex = fullText.toLowerCase().indexOf(quote.toLowerCase());
    }
    if (matchIndex === -1) return null;

    const matchEnd = matchIndex + quote.length;
    let startNode = null, startOffset = 0, endNode = null, endOffset = 0;

    for (const { node, start } of nodeMap) {
      const nodeEnd = start + node.textContent.length;
      if (startNode === null && matchIndex >= start && matchIndex < nodeEnd) {
        startNode = node;
        startOffset = matchIndex - start;
      }
      if (matchEnd > start && matchEnd <= nodeEnd) {
        endNode = node;
        endOffset = matchEnd - start;
        break;
      }
    }

    if (!startNode || !endNode) return null;

    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);

    return wrapRangeWithHighlight(range, id, type);
  }

  function wrapRangeWithHighlight(range, id, type) {
    const mark = document.createElement('mark');
    mark.className = 'an-highlight an-type-' + type;
    mark.dataset.annotationId = String(id);

    try {
      range.surroundContents(mark);
      return mark;
    } catch (e) {
      try {
        const contents = range.extractContents();
        mark.appendChild(contents);
        range.insertNode(mark);
        return mark;
      } catch (e2) {
        return null;
      }
    }
  }

  function clearHighlights() {
    for (const mark of highlightElements) {
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }
    highlightElements = [];
    annotations = [];
  }

  async function clearAllAnnotations() {
    clearHighlights();
    dismissedIds = new Set();
    await clearCache();
    buildToc();
    if (overlayContainer) showStatus('Annotations cleared', false, 2000);
  }

  function dismissAnnotation(annotationId) {
    dismissedIds.add(annotationId);

    const mark = document.querySelector('mark.an-highlight[data-annotation-id="' + annotationId + '"]');
    if (mark) {
      const parent = mark.parentNode;
      if (parent) {
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
        parent.normalize();
      }
      highlightElements = highlightElements.filter(m => m !== mark);
    }

    annotations = annotations.filter(a => a.id !== annotationId);
    hideTooltip();
    buildToc();
    saveToCache();
  }

  function attachHighlightListeners(mark, annotation) {
    mark.addEventListener('mouseenter', () => {
      showTooltip(annotation, mark);
    });
    mark.addEventListener('mouseleave', () => {
      scheduleHideTooltip();
    });
    mark.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideTooltip();
      openChat(annotation);
    });
  }

  // ============================================================
  // Overlay Container (Shadow DOM for all overlay UI)
  // ============================================================
  function createOverlay() {
    overlayContainer = document.createElement('div');
    overlayContainer.id = 'dominion-overlay';
    overlayShadow = overlayContainer.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = getOverlayStyles();
    overlayShadow.appendChild(style);

    tooltipEl = document.createElement('div');
    tooltipEl.className = 'an-tooltip';
    overlayShadow.appendChild(tooltipEl);

    statusBannerEl = document.createElement('div');
    statusBannerEl.className = 'an-status-banner';
    overlayShadow.appendChild(statusBannerEl);

    chatPanelEl = document.createElement('div');
    chatPanelEl.className = 'an-chat-panel';
    overlayShadow.appendChild(chatPanelEl);

    selectionMenuEl = document.createElement('div');
    selectionMenuEl.className = 'an-selection-menu';
    overlayShadow.appendChild(selectionMenuEl);

    tocEl = document.createElement('div');
    tocEl.className = 'an-toc';
    overlayShadow.appendChild(tocEl);

    document.body.appendChild(overlayContainer);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeChat();
        hideSelectionMenu();
      }
    });

    document.addEventListener('mouseup', handleTextSelection);
    document.addEventListener('mousedown', (e) => {
      if (e.target === overlayContainer) return;
      hideSelectionMenu();
    });
  }

  // ============================================================
  // Status Banner
  // ============================================================
  function showStatus(text, isError = false, autoHideMs = 0) {
    if (!statusBannerEl) return;
    const showSpinner = !isError && autoHideMs === 0;
    statusBannerEl.className = 'an-status-banner' + (isError ? ' an-error' : '') + ' an-visible';
    statusBannerEl.innerHTML =
      '<div class="an-status-content">' +
        (showSpinner ? '<div class="an-spinner"></div>' : '') +
        '<span>' + escapeHtml(text) + '</span>' +
      '</div>';
    if (autoHideMs > 0) setTimeout(hideStatus, autoHideMs);
    if (isError) setTimeout(hideStatus, 6000);
  }

  function hideStatus() {
    if (statusBannerEl) statusBannerEl.className = 'an-status-banner';
  }

  // ============================================================
  // Tooltip
  // ============================================================
  function showTooltip(annotation, highlightEl) {
    clearTimeout(tooltipHideTimer);
    const meta = ANNOTATION_META[annotation.type] || ANNOTATION_META['context'];
    const hasChat = annotation.chatHistory && annotation.chatHistory.length > 0;

    tooltipEl.innerHTML =
      '<div class="an-tooltip-inner" style="--type-color: ' + meta.color + '">' +
        '<div class="an-tooltip-header">' +
          '<span class="an-type-badge">' + meta.icon + ' ' + meta.label + '</span>' +
          (annotation.source === 'user' ? '<span class="an-source-badge">User</span>' : '') +
        '</div>' +
        '<div class="an-tooltip-title">' + escapeHtml(annotation.title) + '</div>' +
        '<div class="an-tooltip-body">' + escapeHtml(annotation.explanation) + '</div>' +
        '<div class="an-tooltip-actions">' +
          '<button class="an-tooltip-discuss">\u{1F4AC} ' + (hasChat ? 'Continue chat' : 'Discuss') + '</button>' +
          '<button class="an-tooltip-dismiss">\u2715 Dismiss</button>' +
        '</div>' +
      '</div>';

    tooltipEl.className = 'an-tooltip an-visible';

    const rect = highlightEl.getBoundingClientRect();
    let top = rect.bottom + 8;
    let left = rect.left;

    requestAnimationFrame(() => {
      const tRect = tooltipEl.getBoundingClientRect();
      if (left + tRect.width > window.innerWidth - 16) {
        left = window.innerWidth - tRect.width - 16;
      }
      if (left < 16) left = 16;
      if (top + tRect.height > window.innerHeight - 16) {
        top = rect.top - tRect.height - 8;
      }
      tooltipEl.style.left = left + 'px';
      tooltipEl.style.top = top + 'px';
    });

    tooltipEl.onmouseenter = () => clearTimeout(tooltipHideTimer);
    tooltipEl.onmouseleave = () => hideTooltip();

    const discussBtn = tooltipEl.querySelector('.an-tooltip-discuss');
    if (discussBtn) {
      discussBtn.onclick = () => {
        hideTooltip();
        openChat(annotation);
      };
    }

    const dismissBtn = tooltipEl.querySelector('.an-tooltip-dismiss');
    if (dismissBtn) {
      dismissBtn.onclick = () => {
        dismissAnnotation(annotation.id);
      };
    }
  }

  function scheduleHideTooltip() {
    tooltipHideTimer = setTimeout(hideTooltip, 300);
  }

  function hideTooltip() {
    clearTimeout(tooltipHideTimer);
    if (tooltipEl) tooltipEl.className = 'an-tooltip';
  }

  // ============================================================
  // Chat Panel (slide-in sidebar) — with persistent history
  // ============================================================
  function openChat(annotation) {
    currentChatAnnotation = annotation;
    chatConversationHistory = annotation.chatHistory ? [...annotation.chatHistory] : [];
    isChatProcessing = false;

    const meta = ANNOTATION_META[annotation.type] || ANNOTATION_META['context'];

    chatPanelEl.innerHTML =
      '<div class="an-chat-inner">' +
        '<div class="an-chat-header">' +
          '<div class="an-chat-header-info">' +
            '<span class="an-type-badge" style="--type-color: ' + meta.color + '">' + meta.icon + ' ' + meta.label + '</span>' +
            '<h3>' + escapeHtml(annotation.title) + '</h3>' +
          '</div>' +
          '<button class="an-chat-close" aria-label="Close">\u2715</button>' +
        '</div>' +
        '<div class="an-chat-context">' +
          '<blockquote>\u201C' + escapeHtml(annotation.quote) + '\u201D</blockquote>' +
          '<p>' + escapeHtml(annotation.explanation) + '</p>' +
        '</div>' +
        '<div class="an-chat-messages"></div>' +
        '<div class="an-chat-input-area">' +
          '<textarea class="an-chat-input" placeholder="Ask about this section\u2026" rows="1"></textarea>' +
          '<button class="an-chat-send-btn" aria-label="Send">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
              '<line x1="22" y1="2" x2="11" y2="13"/>' +
              '<polygon points="22 2 15 22 11 13 2 9 22 2"/>' +
            '</svg>' +
          '</button>' +
        '</div>' +
      '</div>';

    chatPanelEl.className = 'an-chat-panel an-visible';

    // Restore previous chat messages
    if (chatConversationHistory.length > 0) {
      for (const msg of chatConversationHistory) {
        addChatMessage(msg.content, msg.role);
      }
    }

    const closeBtn = chatPanelEl.querySelector('.an-chat-close');
    const input = chatPanelEl.querySelector('.an-chat-input');
    const sendBtn = chatPanelEl.querySelector('.an-chat-send-btn');

    closeBtn.addEventListener('click', closeChat);
    sendBtn.addEventListener('click', sendChatMessage);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    setTimeout(() => input.focus(), 150);
  }

  function closeChat() {
    if (chatPanelEl) chatPanelEl.className = 'an-chat-panel';
    currentChatAnnotation = null;
    chatConversationHistory = [];
    isChatProcessing = false;
  }

  async function sendChatMessage() {
    const input = chatPanelEl.querySelector('.an-chat-input');
    if (!input) return;
    const userMessage = input.value.trim();
    if (!userMessage || isChatProcessing) return;

    isChatProcessing = true;
    input.value = '';
    input.style.height = 'auto';

    addChatMessage(userMessage, 'user');
    const loadingEl = addChatLoading();

    try {
      const result = await chrome.storage.sync.get(['geminiApiKey', 'geminiModel']);
      if (!result.geminiApiKey) {
        if (loadingEl) loadingEl.remove();
        addChatMessage('Please set your API key in the extension popup.', 'assistant', true);
        isChatProcessing = false;
        return;
      }

      chatConversationHistory.push({ role: 'user', content: userMessage });

      const port = chrome.runtime.connect({ name: 'dominion-chat' });
      let fullResponse = '';
      let streamingEl = null;

      port.onMessage.addListener((msg) => {
        if (msg.type === 'chunk') {
          if (!streamingEl) {
            if (loadingEl) loadingEl.remove();
            streamingEl = addChatStreamingMessage();
          }
          fullResponse += msg.text;
          updateChatStreamingMessage(streamingEl, fullResponse);
        } else if (msg.type === 'done') {
          if (!streamingEl) {
            if (loadingEl) loadingEl.remove();
            addChatMessage('No response generated.', 'assistant', true);
          } else {
            chatConversationHistory.push({ role: 'assistant', content: fullResponse });
            if (currentChatAnnotation) {
              currentChatAnnotation.chatHistory = [...chatConversationHistory];
              saveToCache();
            }
          }
          isChatProcessing = false;
          port.disconnect();
        } else if (msg.type === 'error') {
          if (loadingEl) loadingEl.remove();
          if (streamingEl) streamingEl.remove();
          addChatMessage('Error: ' + msg.error, 'assistant', true);
          isChatProcessing = false;
          port.disconnect();
        }
      });

      port.onDisconnect.addListener(() => {
        if (isChatProcessing) {
          if (loadingEl) loadingEl.remove();
          if (!streamingEl) addChatMessage('Connection lost.', 'assistant', true);
          isChatProcessing = false;
        }
      });

      port.postMessage({
        action: 'chat',
        apiKey: result.geminiApiKey,
        model: result.geminiModel || 'gemini-3.1-flash-lite-preview',
        articleContent: articleContent.markdown,
        articleTitle: articleContent.title,
        annotation: currentChatAnnotation,
        conversationHistory: chatConversationHistory
      });

    } catch (error) {
      if (loadingEl) loadingEl.remove();
      addChatMessage('Error: ' + error.message, 'assistant', true);
      isChatProcessing = false;
    }
  }

  // Chat message helpers
  function getChatMessagesContainer() {
    return chatPanelEl.querySelector('.an-chat-messages');
  }

  function addChatMessage(content, role, isError = false) {
    const container = getChatMessagesContainer();
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'an-chat-msg an-' + role + (isError ? ' an-error' : '');
    const formatted = role === 'assistant' ? parseMarkdown(content) : escapeHtml(content);
    el.innerHTML = '<div class="an-chat-msg-content">' + formatted + '</div>';
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  function addChatLoading() {
    const container = getChatMessagesContainer();
    if (!container) return null;
    const el = document.createElement('div');
    el.className = 'an-chat-msg an-assistant an-loading';
    el.innerHTML = '<div class="an-chat-msg-content"><div class="an-typing"><span></span><span></span><span></span></div></div>';
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    return el;
  }

  function addChatStreamingMessage() {
    const container = getChatMessagesContainer();
    if (!container) return null;
    const el = document.createElement('div');
    el.className = 'an-chat-msg an-assistant';
    el.innerHTML = '<div class="an-chat-msg-content"></div>';
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    return el;
  }

  function updateChatStreamingMessage(el, content) {
    const c = el.querySelector('.an-chat-msg-content');
    if (c) c.innerHTML = parseMarkdown(content);
    const container = getChatMessagesContainer();
    if (container) container.scrollTop = container.scrollHeight;
  }

  // ============================================================
  // Table of Contents Sidebar
  // ============================================================
  function buildToc() {
    if (!tocEl) return;
    if (annotations.length === 0) {
      tocEl.className = 'an-toc';
      tocEl.innerHTML = '';
      return;
    }

    const items = annotations.map(ann => {
      const meta = ANNOTATION_META[ann.type] || ANNOTATION_META['context'];
      const truncQuote = ann.quote.length > 50 ? ann.quote.slice(0, 50) + '\u2026' : ann.quote;
      return (
        '<button class="an-toc-item" data-id="' + ann.id + '" style="--item-color: ' + meta.color + '">' +
          '<span class="an-toc-icon">' + meta.icon + '</span>' +
          '<span class="an-toc-item-text">' +
            '<span class="an-toc-item-title">' + escapeHtml(ann.title) + '</span>' +
            '<span class="an-toc-item-quote">' + escapeHtml(truncQuote) + '</span>' +
          '</span>' +
        '</button>'
      );
    }).join('');

    tocEl.innerHTML =
      '<div class="an-toc-inner' + (isTocMinimized ? ' an-minimized' : '') + '">' +
        '<div class="an-toc-header">' +
          '<span class="an-toc-heading">DOMinion \u00B7 ' + annotations.length + '</span>' +
          '<button class="an-toc-toggle" aria-label="Toggle">' +
            (isTocMinimized ? '\u{25B6}' : '\u{25BC}') +
          '</button>' +
        '</div>' +
        '<div class="an-toc-body">' + items + '</div>' +
      '</div>';

    tocEl.className = 'an-toc an-visible';

    tocEl.querySelector('.an-toc-toggle').addEventListener('click', toggleToc);
    tocEl.querySelector('.an-toc-header').addEventListener('click', (e) => {
      if (e.target.closest('.an-toc-toggle')) return;
      toggleToc();
    });

    tocEl.querySelectorAll('.an-toc-item').forEach(btn => {
      btn.addEventListener('click', () => {
        scrollToAnnotation(btn.dataset.id);
      });
    });
  }

  function toggleToc() {
    isTocMinimized = !isTocMinimized;
    buildToc();
  }

  function scrollToAnnotation(annotationId) {
    const mark = document.querySelector('mark.an-highlight[data-annotation-id="' + annotationId + '"]');
    if (!mark) return;
    mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    mark.classList.add('an-pulse');
    setTimeout(() => mark.classList.remove('an-pulse'), 1500);
  }

  // ============================================================
  // Selection Context Menu
  // ============================================================
  function handleTextSelection(e) {
    if (e.target === overlayContainer) return;
    if (isSelectionAnalyzing) return;

    setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.toString().trim().length < 5) {
        return;
      }

      savedSelectionRange = selection.getRangeAt(0).cloneRange();
      showSelectionMenu(selection);
    }, 10);
  }

  function showSelectionMenu(selection) {
    if (!selectionMenuEl || !overlayContainer) {
      if (!overlayContainer) createOverlay();
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    const buttons = Object.entries(ANNOTATION_META).map(([type, meta]) =>
      '<button class="an-sel-btn" data-type="' + type + '" style="--btn-color: ' + meta.color + '">' +
        '<span class="an-sel-icon">' + meta.icon + '</span>' +
        '<span class="an-sel-label">' + meta.label + '</span>' +
      '</button>'
    ).join('');

    selectionMenuEl.innerHTML =
      '<div class="an-selection-menu-inner">' + buttons + '</div>';

    selectionMenuEl.className = 'an-selection-menu an-visible';

    requestAnimationFrame(() => {
      const menuRect = selectionMenuEl.getBoundingClientRect();
      let top = rect.top - menuRect.height - 8;
      let left = rect.left + (rect.width / 2) - (menuRect.width / 2);

      if (top < 8) top = rect.bottom + 8;
      if (left < 8) left = 8;
      if (left + menuRect.width > window.innerWidth - 8) {
        left = window.innerWidth - menuRect.width - 8;
      }

      selectionMenuEl.style.left = left + 'px';
      selectionMenuEl.style.top = top + 'px';
    });

    selectionMenuEl.querySelectorAll('.an-sel-btn').forEach(btn => {
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        const type = btn.dataset.type;
        hideSelectionMenu();
        analyzeSelection(type);
      });
    });
  }

  function hideSelectionMenu() {
    if (selectionMenuEl) selectionMenuEl.className = 'an-selection-menu';
  }

  async function analyzeSelection(annotationType) {
    if (!savedSelectionRange || isSelectionAnalyzing) return;
    isSelectionAnalyzing = true;

    const selectedText = savedSelectionRange.toString().trim();
    const range = savedSelectionRange;

    if (!overlayContainer) createOverlay();
    if (!articleContent) articleContent = extractArticleContent();

    showStatus('Analyzing selection\u2026');

    try {
      const result = await chrome.storage.sync.get(['geminiApiKey', 'geminiModel']);
      if (!result.geminiApiKey) {
        showStatus('Please set your API key in the extension popup.', true);
        isSelectionAnalyzing = false;
        return;
      }

      const response = await chrome.runtime.sendMessage({
        action: 'analyzeSelection',
        apiKey: result.geminiApiKey,
        model: result.geminiModel || 'gemini-3.1-flash-lite-preview',
        selectedText: selectedText,
        annotationType: annotationType,
        articleContent: articleContent.markdown,
        articleTitle: articleContent.title
      });

      if (response.error) {
        showStatus('Error: ' + response.error, true);
        isSelectionAnalyzing = false;
        return;
      }

      const annotation = response.annotation;
      annotation.id = generateId();
      annotation.source = 'user';
      annotation.chatHistory = [];
      annotations.push(annotation);

      const mark = wrapRangeWithHighlight(range, annotation.id, annotation.type);
      if (mark) {
        highlightElements.push(mark);
        attachHighlightListeners(mark, annotation);
        buildToc();
        await saveToCache();
        showStatus('\u2713 Annotation added', false, 2500);
        showTooltip(annotation, mark);
      } else {
        showStatus('Could not highlight the selection', true);
      }

    } catch (error) {
      showStatus('Error: ' + error.message, true);
    }

    savedSelectionRange = null;
    isSelectionAnalyzing = false;
  }

  // ============================================================
  // Utilities
  // ============================================================
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function parseMarkdown(text) {
    let html = escapeHtml(text);
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    if (!html.startsWith('<')) html = '<p>' + html + '</p>';
    return html;
  }

  // ============================================================
  // Overlay Styles (isolated inside shadow DOM)
  // ============================================================
  function getOverlayStyles() {
    return `
      :host {
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        width: 0 !important;
        height: 0 !important;
        overflow: visible !important;
        z-index: 2147483647 !important;
        pointer-events: none !important;
      }

      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
        font-family: 'Inter', system-ui, -apple-system, sans-serif;
        font-size: 14px;
        line-height: 1.5;
        color: #1A1A1A;
      }

      /* ===== Status Banner ===== */
      .an-status-banner {
        position: fixed;
        top: -60px;
        left: 50%;
        transform: translateX(-50%);
        transition: top 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        pointer-events: auto;
        z-index: 10000;
      }
      .an-status-banner.an-visible { top: 16px; }

      .an-status-content {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 20px;
        background: #FFFDF5;
        color: #1A1A1A;
        border: 1.5px solid rgba(26,26,26,0.13);
        border-radius: 10px;
        box-shadow: 3px 3px 0 rgba(26,26,26,0.06), 0 4px 16px rgba(26,26,26,0.06);
        font-size: 13px;
        font-weight: 600;
        white-space: nowrap;
      }
      .an-status-content span { color: #1A1A1A; }
      .an-status-banner.an-error .an-status-content {
        background: #FFF5F5;
        border-color: rgba(255,107,107,0.4);
        color: #FF6B6B;
        box-shadow: 3px 3px 0 rgba(255,107,107,0.08), 0 4px 16px rgba(26,26,26,0.06);
      }
      .an-status-banner.an-error .an-status-content span { color: #FF6B6B; }

      .an-spinner {
        width: 14px; height: 14px;
        border: 2.5px solid rgba(26,26,26,0.1);
        border-top-color: #F9E547;
        border-radius: 50%;
        animation: an-spin 0.8s linear infinite;
      }
      @keyframes an-spin { to { transform: rotate(360deg); } }

      /* ===== Tooltip ===== */
      .an-tooltip {
        position: fixed;
        top: 0; left: 0;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s ease;
        z-index: 10000;
      }
      .an-tooltip.an-visible { opacity: 1; pointer-events: auto; }

      .an-tooltip-inner {
        background: #FFFDF5;
        border: 1.5px solid rgba(26,26,26,0.12);
        border-radius: 12px;
        box-shadow: 4px 4px 0 rgba(26,26,26,0.05), 0 8px 24px rgba(26,26,26,0.08);
        max-width: 380px;
        min-width: 280px;
        overflow: hidden;
      }
      .an-tooltip-header {
        padding: 14px 16px 0;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .an-type-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 3px 10px;
        background: var(--type-color);
        color: #1A1A1A;
        border: 1px solid rgba(26,26,26,0.08);
        border-radius: 100px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.02em;
        box-shadow: 1px 1px 0 rgba(26,26,26,0.04);
      }
      .an-source-badge {
        padding: 2px 8px;
        background: rgba(176,155,253,0.35);
        color: #1A1A1A;
        border: 1px solid rgba(140,115,240,0.15);
        border-radius: 100px;
        font-size: 10px;
        font-weight: 700;
      }
      .an-tooltip-title {
        padding: 10px 16px 4px;
        font-size: 15px;
        font-weight: 700;
        color: #1A1A1A;
        letter-spacing: -0.01em;
      }
      .an-tooltip-body {
        padding: 0 16px 14px;
        font-size: 13px;
        color: #333;
        line-height: 1.6;
      }
      .an-tooltip-actions {
        display: flex;
        border-top: 1.5px solid rgba(26,26,26,0.08);
      }
      .an-tooltip-discuss, .an-tooltip-dismiss {
        flex: 1;
        padding: 10px 16px;
        background: transparent;
        border: none;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s;
        text-align: center;
        color: #1A1A1A;
      }
      .an-tooltip-discuss {
        color: #1A1A1A;
        border-right: 1.5px solid rgba(26,26,26,0.08);
      }
      .an-tooltip-dismiss { opacity: 0.5; }
      .an-tooltip-discuss:hover { background: rgba(249,229,71,0.25); }
      .an-tooltip-dismiss:hover { background: rgba(255,107,107,0.12); opacity: 1; color: #FF6B6B; }

      /* ===== Selection Context Menu ===== */
      .an-selection-menu {
        position: fixed;
        top: 0; left: 0;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.12s ease, transform 0.12s ease;
        transform: translateY(4px);
        z-index: 10001;
      }
      .an-selection-menu.an-visible {
        opacity: 1;
        pointer-events: auto;
        transform: translateY(0);
      }
      .an-selection-menu-inner {
        display: flex;
        gap: 2px;
        padding: 4px;
        background: #FFFDF5;
        border: 1.5px solid rgba(26,26,26,0.12);
        border-radius: 10px;
        box-shadow: 3px 3px 0 rgba(26,26,26,0.05), 0 6px 20px rgba(26,26,26,0.08);
      }
      .an-sel-btn {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 7px 12px;
        border: none;
        border-radius: 7px;
        background: transparent;
        cursor: pointer;
        transition: background 0.15s, box-shadow 0.15s;
        white-space: nowrap;
      }
      .an-sel-btn:hover {
        background: rgba(26,26,26,0.06);
      }
      .an-sel-icon { font-size: 14px; line-height: 1; }
      .an-sel-label {
        font-size: 12px;
        font-weight: 600;
        color: #1A1A1A;
        opacity: 0.7;
      }
      .an-sel-btn:hover .an-sel-label { opacity: 1; }

      /* ===== TOC Sidebar ===== */
      .an-toc {
        position: fixed;
        bottom: 20px;
        left: 20px;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease, transform 0.2s ease;
        transform: translateY(6px);
        z-index: 9998;
      }
      .an-toc.an-visible {
        opacity: 1;
        pointer-events: auto;
        transform: translateY(0);
      }
      .an-toc-inner {
        background: #FFFDF5;
        border: 1.5px solid rgba(26,26,26,0.12);
        border-radius: 12px;
        box-shadow: 4px 4px 0 rgba(26,26,26,0.05), 0 8px 24px rgba(26,26,26,0.08);
        width: 280px;
        max-height: 400px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .an-toc-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 14px;
        border-bottom: 1.5px solid rgba(26,26,26,0.08);
        cursor: pointer;
        user-select: none;
        flex-shrink: 0;
        transition: background 0.15s;
      }
      .an-toc-header:hover { background: rgba(249,229,71,0.1); }
      .an-toc-heading {
        font-size: 11px;
        font-weight: 700;
        color: #1A1A1A;
        opacity: 0.55;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .an-toc-toggle {
        background: none;
        border: 1px solid rgba(26,26,26,0.08);
        width: 22px; height: 22px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font-size: 10px;
        color: #1A1A1A;
        opacity: 0.4;
        border-radius: 6px;
        transition: opacity 0.15s, background 0.15s;
      }
      .an-toc-toggle:hover { opacity: 0.8; background: rgba(26,26,26,0.05); }
      .an-toc-body {
        overflow-y: auto;
        padding: 4px;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .an-toc-inner.an-minimized .an-toc-body { display: none; }
      .an-toc-inner.an-minimized { width: auto; min-width: 180px; }
      .an-toc-item {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 8px 10px;
        border: none;
        border-radius: 8px;
        background: transparent;
        cursor: pointer;
        transition: background 0.15s, box-shadow 0.15s;
        text-align: left;
        width: 100%;
        border-left: 3px solid var(--item-color);
      }
      .an-toc-item:hover {
        background: rgba(26,26,26,0.035);
        box-shadow: inset 0 0 0 1px rgba(26,26,26,0.04);
      }
      .an-toc-icon {
        font-size: 13px;
        line-height: 1;
        flex-shrink: 0;
        margin-top: 2px;
      }
      .an-toc-item-text {
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
      }
      .an-toc-item-title {
        font-size: 12px;
        font-weight: 600;
        color: #1A1A1A;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .an-toc-item-quote {
        font-size: 11px;
        color: #555;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-style: italic;
      }

      /* ===== Chat Panel ===== */
      .an-chat-panel {
        position: fixed;
        top: 0;
        right: -420px;
        width: 400px;
        height: 100vh;
        background: #FFFDF5;
        border-left: 1.5px solid rgba(26,26,26,0.12);
        box-shadow: -4px 0 0 rgba(26,26,26,0.04), -8px 0 24px rgba(26,26,26,0.06);
        transition: right 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        pointer-events: auto;
        z-index: 9999;
      }
      .an-chat-panel.an-visible { right: 0; }

      .an-chat-inner {
        display: flex;
        flex-direction: column;
        height: 100%;
      }
      .an-chat-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        padding: 16px 18px;
        border-bottom: 1.5px solid rgba(26,26,26,0.08);
        gap: 12px;
      }
      .an-chat-header-info { flex: 1; }
      .an-chat-header-info .an-type-badge { margin-bottom: 4px; }
      .an-chat-header-info h3 {
        margin-top: 6px;
        font-size: 15px;
        font-weight: 700;
        color: #1A1A1A;
        letter-spacing: -0.01em;
      }
      .an-chat-close {
        background: transparent;
        border: 1px solid rgba(26,26,26,0.08);
        width: 30px; height: 30px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 16px;
        color: #1A1A1A;
        opacity: 0.4;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: all 0.15s;
      }
      .an-chat-close:hover {
        opacity: 1;
        background: rgba(255,107,107,0.1);
        border-color: rgba(255,107,107,0.3);
        color: #FF6B6B;
      }

      .an-chat-context {
        padding: 14px 18px;
        background: rgba(249,229,71,0.15);
        border-bottom: 1.5px solid rgba(249,229,71,0.25);
      }
      .an-chat-context blockquote {
        font-style: italic;
        color: #1A1A1A;
        opacity: 0.65;
        border-left: 3px solid rgba(200,180,20,0.7);
        padding-left: 12px;
        margin-bottom: 8px;
        font-size: 13px;
      }
      .an-chat-context p {
        font-size: 12px;
        color: #333;
        line-height: 1.6;
      }

      .an-chat-messages {
        flex: 1;
        overflow-y: auto;
        padding: 16px 18px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .an-chat-msg { max-width: 90%; }
      .an-chat-msg.an-user { align-self: flex-end; }
      .an-chat-msg.an-assistant { align-self: flex-start; }

      .an-chat-msg-content {
        padding: 10px 14px;
        border-radius: 12px;
        word-break: break-word;
        font-size: 13px;
        line-height: 1.6;
      }
      .an-user .an-chat-msg-content {
        background: #C4B5FD;
        color: #1A1A1A;
        border: 1px solid rgba(140,115,240,0.2);
        border-bottom-right-radius: 4px;
        box-shadow: 2px 2px 0 rgba(140,115,240,0.08);
      }
      .an-user .an-chat-msg-content * { color: #1A1A1A; }
      .an-assistant .an-chat-msg-content {
        background: rgba(26,26,26,0.045);
        color: #1A1A1A;
        border: 1px solid rgba(26,26,26,0.06);
        border-bottom-left-radius: 4px;
      }
      .an-error .an-chat-msg-content {
        background: rgba(255,107,107,0.12);
        color: #FF6B6B;
        border-color: rgba(255,107,107,0.2);
      }
      .an-error .an-chat-msg-content * { color: #FF6B6B; }

      .an-chat-msg-content p { margin-bottom: 6px; }
      .an-chat-msg-content p:last-child { margin-bottom: 0; }
      .an-chat-msg-content strong { font-weight: 700; }
      .an-chat-msg-content code {
        background: rgba(249,229,71,0.25);
        padding: 1px 5px;
        border-radius: 4px;
        font-family: 'SF Mono', Monaco, 'Courier New', monospace;
        font-size: 12px;
        border: 1px solid rgba(249,229,71,0.2);
      }
      .an-chat-msg-content pre {
        background: #1A1A1A;
        color: #FFFDF5;
        padding: 10px;
        border-radius: 8px;
        overflow-x: auto;
        margin: 6px 0;
        border: 1.5px solid #333;
      }
      .an-chat-msg-content pre code {
        background: none;
        padding: 0;
        color: inherit;
        border: none;
      }
      .an-chat-msg-content ul, .an-chat-msg-content ol {
        margin: 6px 0;
        padding-left: 18px;
      }

      .an-typing {
        display: flex;
        gap: 4px;
        padding: 4px 0;
      }
      .an-typing span {
        width: 6px; height: 6px;
        background: #B0A0F0;
        border-radius: 50%;
        animation: an-bounce 1.4s ease-in-out infinite;
      }
      .an-typing span:nth-child(2) { animation-delay: 0.2s; }
      .an-typing span:nth-child(3) { animation-delay: 0.4s; }
      @keyframes an-bounce {
        0%, 60%, 100% { transform: translateY(0); }
        30% { transform: translateY(-4px); }
      }

      .an-chat-input-area {
        display: flex;
        gap: 8px;
        align-items: flex-end;
        padding: 14px 18px;
        border-top: 1.5px solid rgba(26,26,26,0.08);
      }
      .an-chat-input-area textarea {
        flex: 1;
        padding: 10px 12px;
        border: 1.5px solid rgba(26,26,26,0.14);
        border-radius: 10px;
        font-family: inherit;
        font-size: 13px;
        line-height: 1.5;
        resize: none;
        min-height: 40px;
        max-height: 120px;
        color: #1A1A1A;
        background: #FFFDF5;
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      .an-chat-input-area textarea:focus {
        outline: none;
        border-color: #B0A0F0;
        box-shadow: 0 0 0 3px rgba(176,155,253,0.2);
      }
      .an-chat-input-area textarea::placeholder {
        color: #1A1A1A;
        opacity: 0.3;
      }

      .an-chat-send-btn {
        background: #F9E547;
        border: 1.5px solid rgba(26,26,26,0.12);
        padding: 10px;
        border-radius: 10px;
        cursor: pointer;
        transition: all 0.15s;
        flex-shrink: 0;
        box-shadow: 2px 2px 0 rgba(26,26,26,0.06);
      }
      .an-chat-send-btn:hover {
        background: #f7df2e;
        box-shadow: 1px 1px 0 rgba(26,26,26,0.08);
        transform: translate(0.5px, 0.5px);
      }
      .an-chat-send-btn svg { width: 16px; height: 16px; color: #1A1A1A; }
    `;
  }

  // ============================================================
  // Auto-restore cached annotations on page load
  // ============================================================
  restoreFromCache();

})();
