// ArticleNotes Content Script
// Inline article annotations with tooltips and chat

(function() {
  'use strict';

  // ============================================================
  // Constants
  // ============================================================
  const ANNOTATION_META = {
    'fact-check': { icon: '\u{1F50D}', label: 'Fact-check',      color: '#f59e0b' },
    'jargon':     { icon: '\u{1F4D6}', label: 'Explanation',     color: '#3b82f6' },
    'source':     { icon: '\u{1F517}', label: 'Source Analysis',  color: '#10b981' },
    'context':    { icon: '\u{2795}',  label: 'Missing Context',  color: '#8b5cf6' }
  };

  // ============================================================
  // State
  // ============================================================
  let annotations = [];
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

  // Chat
  let currentChatAnnotation = null;
  let chatConversationHistory = [];
  let isChatProcessing = false;

  // ============================================================
  // Message Listener
  // ============================================================
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'analyzeArticle') {
      analyzeArticle();
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

    clearAnnotations();
    if (!overlayContainer) createOverlay();

    showStatus('Analyzing article\u2026');

    try {
      articleContent = extractArticleContent();

      const result = await chrome.storage.sync.get(['geminiApiKey']);
      if (!result.geminiApiKey) {
        showStatus('Please set your API key in the extension popup.', true);
        isAnalyzing = false;
        return;
      }

      const response = await chrome.runtime.sendMessage({
        action: 'analyze',
        apiKey: result.geminiApiKey,
        articleContent: articleContent.markdown,
        articleTitle: articleContent.title
      });

      if (response.error) {
        showStatus('Error: ' + response.error, true);
        isAnalyzing = false;
        return;
      }

      annotations = response.annotations;
      highlightAnnotations();

      const placed = highlightElements.length;
      showStatus(
        placed > 0
          ? `\u2713 ${placed} annotation${placed !== 1 ? 's' : ''} added`
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

    // Find positions of all quotes so we can process end-to-start
    // (avoids earlier highlights invalidating later ones)
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let fullText = '';
    while (walker.nextNode()) fullText += walker.currentNode.textContent;

    const positioned = annotations.map((ann, i) => {
      let pos = fullText.indexOf(ann.quote);
      if (pos === -1) pos = fullText.toLowerCase().indexOf(ann.quote.toLowerCase());
      return { annotation: ann, index: i, position: pos };
    }).filter(p => p.position !== -1);

    positioned.sort((a, b) => b.position - a.position);

    for (const { annotation, index } of positioned) {
      const mark = findAndHighlight(container, annotation.quote, index, annotation.type);
      if (mark) {
        highlightElements.push(mark);
        attachHighlightListeners(mark, index);
      }
    }
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
    mark.className = `an-highlight an-type-${type}`;
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

  function clearAnnotations() {
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

  function attachHighlightListeners(mark, annotationId) {
    mark.addEventListener('mouseenter', () => {
      showTooltip(annotations[annotationId], mark);
    });
    mark.addEventListener('mouseleave', () => {
      scheduleHideTooltip();
    });
    mark.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideTooltip();
      openChat(annotations[annotationId]);
    });
  }

  // ============================================================
  // Overlay Container (Shadow DOM for all overlay UI)
  // ============================================================
  function createOverlay() {
    overlayContainer = document.createElement('div');
    overlayContainer.id = 'article-notes-overlay';
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

    tooltipEl.innerHTML =
      '<div class="an-tooltip-inner" style="--type-color: ' + meta.color + '">' +
        '<div class="an-tooltip-header">' +
          '<span class="an-type-badge">' + meta.icon + ' ' + meta.label + '</span>' +
        '</div>' +
        '<div class="an-tooltip-title">' + escapeHtml(annotation.title) + '</div>' +
        '<div class="an-tooltip-body">' + escapeHtml(annotation.explanation) + '</div>' +
        '<button class="an-tooltip-discuss">\u{1F4AC} Discuss this</button>' +
      '</div>';

    tooltipEl.className = 'an-tooltip an-visible';

    const rect = highlightEl.getBoundingClientRect();
    let top = rect.bottom + 8;
    let left = rect.left;

    // Position after rendering so we can measure
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

    const btn = tooltipEl.querySelector('.an-tooltip-discuss');
    if (btn) {
      btn.onclick = () => {
        hideTooltip();
        openChat(annotation);
      };
    }
  }

  function scheduleHideTooltip() {
    tooltipHideTimer = setTimeout(hideTooltip, 300);
  }

  function hideTooltip() {
    clearTimeout(tooltipHideTimer);
    tooltipEl.className = 'an-tooltip';
  }

  // ============================================================
  // Chat Panel (slide-in sidebar)
  // ============================================================
  function openChat(annotation) {
    currentChatAnnotation = annotation;
    chatConversationHistory = [];
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
    chatPanelEl.className = 'an-chat-panel';
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
      const result = await chrome.storage.sync.get(['geminiApiKey']);
      if (!result.geminiApiKey) {
        if (loadingEl) loadingEl.remove();
        addChatMessage('Please set your API key in the extension popup.', 'assistant', true);
        isChatProcessing = false;
        return;
      }

      chatConversationHistory.push({ role: 'user', content: userMessage });

      const port = chrome.runtime.connect({ name: 'article-notes-chat' });
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
      const result = await chrome.storage.sync.get(['geminiApiKey']);
      if (!result.geminiApiKey) {
        showStatus('Please set your API key in the extension popup.', true);
        isSelectionAnalyzing = false;
        return;
      }

      const response = await chrome.runtime.sendMessage({
        action: 'analyzeSelection',
        apiKey: result.geminiApiKey,
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
      const idx = annotations.length;
      annotations.push(annotation);

      const mark = wrapRangeWithHighlight(range, idx, annotation.type);
      if (mark) {
        highlightElements.push(mark);
        attachHighlightListeners(mark, idx);
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

      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
        font-size: 14px;
        line-height: 1.5;
        color: #1a1a2e;
      }

      /* ===== Status Banner ===== */
      .an-status-banner {
        position: fixed;
        top: -60px;
        left: 50%;
        transform: translateX(-50%);
        transition: top 0.3s ease;
        pointer-events: auto;
        z-index: 10000;
      }
      .an-status-banner.an-visible { top: 16px; }

      .an-status-content {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 24px;
        background: #1a1a2e;
        color: #fff;
        border-radius: 12px;
        box-shadow: 0 8px 30px rgba(0,0,0,0.25);
        font-size: 14px;
        font-weight: 500;
        white-space: nowrap;
      }
      .an-status-content span { color: #fff; }
      .an-status-banner.an-error .an-status-content { background: #dc2626; }

      .an-spinner {
        width: 18px; height: 18px;
        border: 2px solid rgba(255,255,255,0.3);
        border-top-color: #fff;
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
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 16px 48px rgba(0,0,0,0.22), 0 0 0 1px rgba(0,0,0,0.08);
        max-width: 380px;
        min-width: 280px;
        overflow: hidden;
      }
      .an-tooltip-header { padding: 12px 16px 0; }

      .an-type-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 3px 10px;
        background: color-mix(in srgb, var(--type-color) 15%, transparent);
        color: var(--type-color);
        border-radius: 20px;
        font-size: 12px;
        font-weight: 600;
      }
      .an-tooltip-title {
        padding: 8px 16px 4px;
        font-size: 15px;
        font-weight: 600;
        color: #1a1a2e;
      }
      .an-tooltip-body {
        padding: 0 16px 12px;
        font-size: 13px;
        color: #4b5563;
        line-height: 1.6;
      }
      .an-tooltip-discuss {
        display: block;
        width: 100%;
        padding: 10px 16px;
        background: #f9fafb;
        border: none;
        border-top: 1px solid #e5e7eb;
        color: #2563eb;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.15s;
        text-align: left;
      }
      .an-tooltip-discuss:hover { background: #eff6ff; }

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
        background: #fff;
        border-radius: 10px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.2), 0 0 0 1px rgba(0,0,0,0.08);
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
        transition: background 0.15s;
        white-space: nowrap;
      }
      .an-sel-btn:hover {
        background: color-mix(in srgb, var(--btn-color) 12%, transparent);
      }
      .an-sel-icon { font-size: 14px; line-height: 1; }
      .an-sel-label {
        font-size: 12px;
        font-weight: 600;
        color: #374151;
      }
      .an-sel-btn:hover .an-sel-label { color: var(--btn-color); }

      /* ===== Chat Panel ===== */
      .an-chat-panel {
        position: fixed;
        top: 0;
        right: -420px;
        width: 400px;
        height: 100vh;
        background: #fff;
        box-shadow: -4px 0 30px rgba(0,0,0,0.12);
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
        padding: 16px 20px;
        border-bottom: 1px solid #e5e7eb;
        gap: 12px;
      }
      .an-chat-header-info { flex: 1; }
      .an-chat-header-info h3 {
        margin-top: 8px;
        font-size: 16px;
        font-weight: 600;
        color: #1a1a2e;
      }
      .an-chat-close {
        background: none;
        border: none;
        width: 32px; height: 32px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 18px;
        color: #6b7280;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.15s;
        flex-shrink: 0;
      }
      .an-chat-close:hover { background: #f3f4f6; }

      .an-chat-context {
        padding: 16px 20px;
        background: #f9fafb;
        border-bottom: 1px solid #e5e7eb;
      }
      .an-chat-context blockquote {
        font-style: italic;
        color: #6b7280;
        border-left: 3px solid #d1d5db;
        padding-left: 12px;
        margin-bottom: 8px;
        font-size: 13px;
      }
      .an-chat-context p {
        font-size: 13px;
        color: #374151;
        line-height: 1.6;
      }

      .an-chat-messages {
        flex: 1;
        overflow-y: auto;
        padding: 16px 20px;
        display: flex;
        flex-direction: column;
        gap: 12px;
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
        background: #2563eb;
        color: #fff;
        border-bottom-right-radius: 4px;
      }
      .an-user .an-chat-msg-content * { color: #fff; }
      .an-assistant .an-chat-msg-content {
        background: #f3f4f6;
        color: #1a1a2e;
        border-bottom-left-radius: 4px;
      }
      .an-error .an-chat-msg-content {
        background: #fef2f2;
        color: #dc2626;
      }
      .an-error .an-chat-msg-content * { color: #dc2626; }

      .an-chat-msg-content p { margin-bottom: 6px; }
      .an-chat-msg-content p:last-child { margin-bottom: 0; }
      .an-chat-msg-content strong { font-weight: 600; }
      .an-chat-msg-content code {
        background: rgba(0,0,0,0.08);
        padding: 1px 5px;
        border-radius: 4px;
        font-family: 'SF Mono', Monaco, 'Courier New', monospace;
        font-size: 12px;
      }
      .an-chat-msg-content pre {
        background: #1a1a2e;
        color: #e5e7eb;
        padding: 10px;
        border-radius: 8px;
        overflow-x: auto;
        margin: 6px 0;
      }
      .an-chat-msg-content pre code {
        background: none;
        padding: 0;
        color: inherit;
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
        width: 7px; height: 7px;
        background: #9ca3af;
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
        gap: 10px;
        align-items: flex-end;
        padding: 16px 20px;
        border-top: 1px solid #e5e7eb;
      }
      .an-chat-input-area textarea {
        flex: 1;
        padding: 10px 14px;
        border: 1px solid #e5e7eb;
        border-radius: 10px;
        font-family: inherit;
        font-size: 13px;
        line-height: 1.5;
        resize: none;
        min-height: 40px;
        max-height: 120px;
        transition: border-color 0.15s, box-shadow 0.15s;
        color: #1a1a2e;
        background: #fff;
      }
      .an-chat-input-area textarea:focus {
        outline: none;
        border-color: #2563eb;
        box-shadow: 0 0 0 3px rgba(37,99,235,0.1);
      }
      .an-chat-input-area textarea::placeholder { color: #9ca3af; }

      .an-chat-send-btn {
        background: #2563eb;
        border: none;
        padding: 10px;
        border-radius: 10px;
        cursor: pointer;
        transition: background 0.15s;
        flex-shrink: 0;
      }
      .an-chat-send-btn:hover { background: #1d4ed8; }
      .an-chat-send-btn svg { width: 18px; height: 18px; color: #fff; }
    `;
  }

})();
