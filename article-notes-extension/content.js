// ArticleNotes Content Script
// Handles content extraction and modal chat UI

(function() {
  'use strict';

  // State
  let modal = null;
  let shadowRoot = null;
  let articleContent = null;
  let conversationHistory = [];
  let isProcessing = false;

  // Listen for messages from popup or background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'openArticleNotes') {
      openModal();
      sendResponse({ success: true });
    }
    return true;
  });

  // Extract article content using Turndown
  function extractArticleContent() {
    // Priority selectors for article content
    const selectors = [
      'article',
      '[role="article"]',
      'main article',
      'main',
      '[role="main"]',
      '.post-content',
      '.article-content',
      '.entry-content',
      '.content',
      '#content',
      '.post',
      '.article'
    ];

    let contentElement = null;
    
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.textContent.trim().length > 500) {
        contentElement = el;
        break;
      }
    }

    // Fallback to body
    if (!contentElement) {
      contentElement = document.body;
    }

    // Clone the element to avoid modifying the original
    const clone = contentElement.cloneNode(true);

    // Remove unwanted elements
    const removeSelectors = [
      'nav', 'header', 'footer', 'aside', 
      '.sidebar', '.navigation', '.menu', '.ads', '.advertisement',
      '.comments', '.comment', '.social-share', '.related-posts',
      'script', 'style', 'noscript', 'iframe', 'svg',
      '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
      '.cookie-banner', '.newsletter-signup', '.popup'
    ];

    removeSelectors.forEach(selector => {
      clone.querySelectorAll(selector).forEach(el => el.remove());
    });

    // Configure Turndown
    const turndownService = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      emDelimiter: '*'
    });

    // Use GFM plugin if available
    if (typeof turndownPluginGfm !== 'undefined') {
      turndownService.use(turndownPluginGfm.gfm);
    }

    // Custom rules
    turndownService.addRule('removeHiddenElements', {
      filter: function(node) {
        const style = window.getComputedStyle(node);
        return style.display === 'none' || style.visibility === 'hidden';
      },
      replacement: function() {
        return '';
      }
    });

    // Handle images
    turndownService.addRule('images', {
      filter: 'img',
      replacement: function(content, node) {
        const alt = node.alt || 'image';
        const src = node.src || '';
        if (!src || src.startsWith('data:')) return '';
        return `![${alt}](${src})`;
      }
    });

    // Convert to Markdown
    const markdown = turndownService.turndown(clone);
    
    return {
      title: document.title,
      url: window.location.href,
      markdown: markdown.trim()
    };
  }

  // Create and open the modal
  function openModal() {
    if (modal) {
      modal.style.display = 'flex';
      return;
    }

    // Extract content on first open
    articleContent = extractArticleContent();
    conversationHistory = [];

    // Create modal container
    modal = document.createElement('div');
    modal.id = 'article-notes-modal-container';
    
    // Create shadow DOM for style isolation
    shadowRoot = modal.attachShadow({ mode: 'open' });
    
    // Inject styles
    const styles = document.createElement('style');
    styles.textContent = getModalStyles();
    shadowRoot.appendChild(styles);

    // Create modal structure
    const modalContent = document.createElement('div');
    modalContent.className = 'an-modal-backdrop';
    modalContent.innerHTML = `
      <div class="an-modal">
        <div class="an-modal-header">
          <h2>ArticleNotes</h2>
          <button class="an-close-btn" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="an-modal-body">
          <div class="an-chat-messages" id="an-messages">
            <div class="an-message an-assistant">
              <div class="an-message-content">
                <p>I've analyzed the article: <strong>${escapeHtml(articleContent.title)}</strong></p>
                <p>Ask me anything about it - I can summarize key points, explain concepts, or answer specific questions.</p>
              </div>
            </div>
          </div>
        </div>
        <div class="an-modal-footer">
          <div class="an-input-container">
            <textarea 
              id="an-input" 
              placeholder="Ask about this article..." 
              rows="1"
            ></textarea>
            <button id="an-send-btn" class="an-send-btn" aria-label="Send">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="22" y1="2" x2="11" y2="13"/>
                <polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    `;

    shadowRoot.appendChild(modalContent);
    document.body.appendChild(modal);

    // Set up event listeners
    setupEventListeners();

    // Focus input
    setTimeout(() => {
      shadowRoot.getElementById('an-input').focus();
    }, 100);
  }

  // Set up modal event listeners
  function setupEventListeners() {
    const backdrop = shadowRoot.querySelector('.an-modal-backdrop');
    const closeBtn = shadowRoot.querySelector('.an-close-btn');
    const input = shadowRoot.getElementById('an-input');
    const sendBtn = shadowRoot.getElementById('an-send-btn');

    // Close on backdrop click
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        closeModal();
      }
    });

    // Close button
    closeBtn.addEventListener('click', closeModal);

    // Send message
    sendBtn.addEventListener('click', sendMessage);

    // Enter to send (Shift+Enter for new line)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Auto-resize textarea
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    // Escape to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && modal.style.display !== 'none') {
        closeModal();
      }
    });
  }

  // Close modal
  function closeModal() {
    if (modal) {
      modal.style.display = 'none';
    }
  }

  // Send message to AI (streaming via port)
  async function sendMessage() {
    const input = shadowRoot.getElementById('an-input');
    const userMessage = input.value.trim();
    
    if (!userMessage || isProcessing) return;

    isProcessing = true;
    input.value = '';
    input.style.height = 'auto';

    addMessage(userMessage, 'user');

    const loadingId = addLoadingMessage();

    try {
      const result = await chrome.storage.sync.get(['geminiApiKey']);
      if (!result.geminiApiKey) {
        removeLoadingMessage(loadingId);
        addMessage('Please set your Gemini API key in the extension popup.', 'assistant', true);
        isProcessing = false;
        return;
      }

      conversationHistory.push({ role: 'user', content: userMessage });

      const port = chrome.runtime.connect({ name: 'article-notes-chat' });
      let fullResponse = '';
      let streamingEl = null;

      port.onMessage.addListener((msg) => {
        if (msg.type === 'chunk') {
          if (!streamingEl) {
            removeLoadingMessage(loadingId);
            streamingEl = addStreamingMessage();
          }
          fullResponse += msg.text;
          updateStreamingMessage(streamingEl, fullResponse);
        } else if (msg.type === 'done') {
          if (!streamingEl) {
            removeLoadingMessage(loadingId);
            addMessage('No response generated. Please try again.', 'assistant', true);
          } else {
            conversationHistory.push({ role: 'assistant', content: fullResponse });
          }
          isProcessing = false;
          port.disconnect();
        } else if (msg.type === 'error') {
          removeLoadingMessage(loadingId);
          if (streamingEl) streamingEl.remove();
          addMessage(`Error: ${msg.error}`, 'assistant', true);
          isProcessing = false;
          port.disconnect();
        }
      });

      port.onDisconnect.addListener(() => {
        if (isProcessing) {
          removeLoadingMessage(loadingId);
          if (!streamingEl) {
            addMessage('Connection lost. Please try again.', 'assistant', true);
          }
          isProcessing = false;
        }
      });

      port.postMessage({
        action: 'chat',
        apiKey: result.geminiApiKey,
        articleContent: articleContent.markdown,
        articleTitle: articleContent.title,
        conversationHistory: conversationHistory
      });

    } catch (error) {
      removeLoadingMessage(loadingId);
      addMessage(`Error: ${error.message}`, 'assistant', true);
      isProcessing = false;
    }
  }

  // Add message to chat
  function addMessage(content, role, isError = false) {
    const messagesContainer = shadowRoot.getElementById('an-messages');
    const messageEl = document.createElement('div');
    messageEl.className = `an-message an-${role}${isError ? ' an-error' : ''}`;
    
    // Parse markdown for assistant messages
    const formattedContent = role === 'assistant' ? parseMarkdown(content) : escapeHtml(content);
    
    messageEl.innerHTML = `
      <div class="an-message-content">
        ${formattedContent}
      </div>
    `;
    
    messagesContainer.appendChild(messageEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // Add loading indicator
  function addLoadingMessage() {
    const messagesContainer = shadowRoot.getElementById('an-messages');
    const loadingEl = document.createElement('div');
    const loadingId = 'loading-' + Date.now();
    loadingEl.id = loadingId;
    loadingEl.className = 'an-message an-assistant an-loading';
    loadingEl.innerHTML = `
      <div class="an-message-content">
        <div class="an-typing-indicator">
          <span></span><span></span><span></span>
        </div>
      </div>
    `;
    messagesContainer.appendChild(loadingEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    return loadingId;
  }

  // Remove loading indicator
  function removeLoadingMessage(loadingId) {
    const loadingEl = shadowRoot.getElementById(loadingId);
    if (loadingEl) {
      loadingEl.remove();
    }
  }

  // Create a message element for streaming content into
  function addStreamingMessage() {
    const messagesContainer = shadowRoot.getElementById('an-messages');
    const messageEl = document.createElement('div');
    messageEl.className = 'an-message an-assistant';
    messageEl.innerHTML = `<div class="an-message-content"></div>`;
    messagesContainer.appendChild(messageEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    return messageEl;
  }

  // Update a streaming message with new content
  function updateStreamingMessage(messageEl, content) {
    const contentEl = messageEl.querySelector('.an-message-content');
    contentEl.innerHTML = parseMarkdown(content);
    const messagesContainer = shadowRoot.getElementById('an-messages');
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // Simple markdown parser
  function parseMarkdown(text) {
    let html = escapeHtml(text);
    
    // Code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    
    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    
    // Italic
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    
    // Headers
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
    
    // Lists
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
    
    // Numbered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    
    // Line breaks
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    
    // Wrap in paragraph if not already wrapped
    if (!html.startsWith('<')) {
      html = '<p>' + html + '</p>';
    }
    
    return html;
  }

  // Escape HTML
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Modal styles
  function getModalStyles() {
    return `
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }

      .an-modal-backdrop {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2147483647;
        animation: an-fadeIn 0.2s ease;
      }

      @keyframes an-fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      @keyframes an-slideUp {
        from { 
          opacity: 0;
          transform: translateY(20px) scale(0.95);
        }
        to { 
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      .an-modal {
        background: #ffffff;
        border-radius: 16px;
        width: 90%;
        max-width: 600px;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
        animation: an-slideUp 0.3s ease;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
        font-size: 14px;
        line-height: 1.5;
        color: #1a1a2e;
      }

      .an-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        border-bottom: 1px solid #e5e7eb;
      }

      .an-modal-header h2 {
        font-size: 18px;
        font-weight: 600;
        color: #1a1a2e;
      }

      .an-close-btn {
        background: none;
        border: none;
        padding: 8px;
        cursor: pointer;
        border-radius: 8px;
        transition: background 0.15s;
      }

      .an-close-btn:hover {
        background: #f3f4f6;
      }

      .an-close-btn svg {
        width: 20px;
        height: 20px;
        color: #6b7280;
      }

      .an-modal-body {
        flex: 1;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      .an-chat-messages {
        flex: 1;
        overflow-y: auto;
        padding: 20px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      .an-message {
        display: flex;
        max-width: 85%;
      }

      .an-message.an-user {
        align-self: flex-end;
      }

      .an-message.an-assistant {
        align-self: flex-start;
      }

      .an-message-content {
        padding: 12px 16px;
        border-radius: 12px;
        word-break: break-word;
      }

      .an-user .an-message-content {
        background: #2563eb;
        color: #ffffff;
        border-bottom-right-radius: 4px;
      }

      .an-assistant .an-message-content {
        background: #f3f4f6;
        color: #1a1a2e;
        border-bottom-left-radius: 4px;
      }

      .an-error .an-message-content {
        background: #fef2f2;
        color: #dc2626;
      }

      .an-message-content p {
        margin-bottom: 8px;
      }

      .an-message-content p:last-child {
        margin-bottom: 0;
      }

      .an-message-content strong {
        font-weight: 600;
      }

      .an-message-content code {
        background: rgba(0, 0, 0, 0.1);
        padding: 2px 6px;
        border-radius: 4px;
        font-family: 'SF Mono', Monaco, 'Courier New', monospace;
        font-size: 13px;
      }

      .an-message-content pre {
        background: #1a1a2e;
        color: #e5e7eb;
        padding: 12px;
        border-radius: 8px;
        overflow-x: auto;
        margin: 8px 0;
      }

      .an-message-content pre code {
        background: none;
        padding: 0;
        color: inherit;
      }

      .an-message-content ul, .an-message-content ol {
        margin: 8px 0;
        padding-left: 20px;
      }

      .an-message-content li {
        margin-bottom: 4px;
      }

      .an-message-content h2, .an-message-content h3, .an-message-content h4 {
        margin: 12px 0 8px 0;
        font-weight: 600;
      }

      .an-typing-indicator {
        display: flex;
        gap: 4px;
        padding: 4px 0;
      }

      .an-typing-indicator span {
        width: 8px;
        height: 8px;
        background: #9ca3af;
        border-radius: 50%;
        animation: an-bounce 1.4s ease-in-out infinite;
      }

      .an-typing-indicator span:nth-child(2) {
        animation-delay: 0.2s;
      }

      .an-typing-indicator span:nth-child(3) {
        animation-delay: 0.4s;
      }

      @keyframes an-bounce {
        0%, 60%, 100% { transform: translateY(0); }
        30% { transform: translateY(-4px); }
      }

      .an-modal-footer {
        padding: 16px 20px;
        border-top: 1px solid #e5e7eb;
      }

      .an-input-container {
        display: flex;
        gap: 12px;
        align-items: flex-end;
      }

      .an-input-container textarea {
        flex: 1;
        padding: 12px 16px;
        border: 1px solid #e5e7eb;
        border-radius: 12px;
        font-family: inherit;
        font-size: 14px;
        line-height: 1.5;
        resize: none;
        min-height: 44px;
        max-height: 120px;
        transition: border-color 0.15s, box-shadow 0.15s;
      }

      .an-input-container textarea:focus {
        outline: none;
        border-color: #2563eb;
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
      }

      .an-input-container textarea::placeholder {
        color: #9ca3af;
      }

      .an-send-btn {
        background: #2563eb;
        border: none;
        padding: 12px;
        border-radius: 12px;
        cursor: pointer;
        transition: background 0.15s;
        flex-shrink: 0;
      }

      .an-send-btn:hover {
        background: #1d4ed8;
      }

      .an-send-btn svg {
        width: 20px;
        height: 20px;
        color: #ffffff;
      }
    `;
  }

})();
