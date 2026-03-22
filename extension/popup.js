const PROVIDERS = {
  gemini: {
    label: 'Gemini API Key',
    models: [
      { value: 'gemini-3.1-flash-lite-preview', label: 'Flash Lite \u2014 fast' },
      { value: 'gemini-3.1-pro-preview', label: 'Pro \u2014 thorough' }
    ]
  },
  openai: {
    label: 'OpenAI API Key',
    models: [
      { value: 'gpt-5.4-nano', label: 'GPT-5.4 Nano \u2014 fast' },
      { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini \u2014 balanced' },
      { value: 'gpt-5.4', label: 'GPT-5.4 \u2014 thorough' }
    ]
  },
  claude: {
    label: 'Anthropic API Key',
    models: [
      { value: 'claude-haiku-4-5', label: 'Haiku 4.5 \u2014 fast' },
      { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 \u2014 balanced' },
      { value: 'claude-opus-4-6', label: 'Opus 4.6 \u2014 thorough' }
    ]
  }
};

const STORAGE_KEYS = [
  'provider',
  'geminiApiKey', 'geminiModel',
  'openaiApiKey', 'openaiModel',
  'claudeApiKey', 'claudeModel'
];

// DOM Elements
const apiKeyInput = document.getElementById('api-key');
const apiKeyLabel = document.getElementById('api-key-label');
const modelSelect = document.getElementById('model-select');
const toggleVisibilityBtn = document.getElementById('toggle-visibility');
const saveKeyBtn = document.getElementById('save-key');
const analyzeBtn = document.getElementById('analyze-btn');
const clearBtn = document.getElementById('clear-btn');
const statusEl = document.getElementById('status');
const iconEye = document.querySelector('.icon-eye');
const iconEyeOff = document.querySelector('.icon-eye-off');
const providerCards = document.querySelectorAll('.provider-card');

let isKeyVisible = false;
let activeProvider = 'gemini';
let storedSettings = {};

document.addEventListener('DOMContentLoaded', async () => {
  document.querySelectorAll('img[data-icon]').forEach(img => {
    img.src = chrome.runtime.getURL(img.dataset.icon);
  });
  await loadSettings();
  initProviderCards();
});

async function loadSettings() {
  try {
    storedSettings = await chrome.storage.sync.get(STORAGE_KEYS);
    activeProvider = storedSettings.provider || 'gemini';
    applyProvider(activeProvider);
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

function initProviderCards() {
  providerCards.forEach(card => {
    card.addEventListener('click', () => {
      const provider = card.dataset.provider;
      if (provider === activeProvider) return;

      stashCurrentKey();
      activeProvider = provider;
      applyProvider(provider);
    });
  });
}

function stashCurrentKey() {
  const key = apiKeyInput.value.trim();
  if (key) {
    storedSettings[`${activeProvider}ApiKey`] = key;
  }
}

function applyProvider(provider) {
  const cfg = PROVIDERS[provider];

  providerCards.forEach(c => c.classList.toggle('active', c.dataset.provider === provider));

  apiKeyLabel.textContent = cfg.label;

  const savedKey = storedSettings[`${provider}ApiKey`] || '';
  apiKeyInput.value = savedKey;
  analyzeBtn.disabled = !savedKey;

  modelSelect.innerHTML = '';
  cfg.models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    modelSelect.appendChild(opt);
  });

  const savedModel = storedSettings[`${provider}Model`];
  if (savedModel) modelSelect.value = savedModel;

  isKeyVisible = false;
  apiKeyInput.type = 'password';
  iconEye.classList.remove('hidden');
  iconEyeOff.classList.add('hidden');

  if (savedKey) {
    updateStatus('Settings loaded', 'success');
  }
}

saveKeyBtn.addEventListener('click', async () => {
  const apiKey = apiKeyInput.value.trim();

  if (!apiKey) {
    updateStatus('Please enter an API key', 'error');
    return;
  }

  try {
    const data = {
      provider: activeProvider,
      [`${activeProvider}ApiKey`]: apiKey,
      [`${activeProvider}Model`]: modelSelect.value
    };
    await chrome.storage.sync.set(data);
    storedSettings = { ...storedSettings, ...data };
    updateStatus('Settings saved', 'success');
    analyzeBtn.disabled = false;
  } catch (error) {
    updateStatus('Error saving settings', 'error');
    console.error('Error saving settings:', error);
  }
});

toggleVisibilityBtn.addEventListener('click', () => {
  isKeyVisible = !isKeyVisible;
  apiKeyInput.type = isKeyVisible ? 'text' : 'password';
  iconEye.classList.toggle('hidden', isKeyVisible);
  iconEyeOff.classList.toggle('hidden', !isKeyVisible);
});

analyzeBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      updateStatus('No active tab found', 'error');
      return;
    }

    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      updateStatus('Cannot analyze browser pages', 'error');
      return;
    }

    await chrome.tabs.sendMessage(tab.id, { action: 'analyzeArticle' });
    window.close();
  } catch (error) {
    updateStatus('Error: Refresh the page and try again', 'error');
    console.error('Error:', error);
  }
});

clearBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      updateStatus('No active tab found', 'error');
      return;
    }

    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      updateStatus('Cannot clear on browser pages', 'error');
      return;
    }

    await chrome.tabs.sendMessage(tab.id, { action: 'clearAnnotations' });
    updateStatus('Annotations cleared', 'success');
    setTimeout(() => window.close(), 800);
  } catch (error) {
    updateStatus('Error: Refresh the page and try again', 'error');
    console.error('Error:', error);
  }
});

function updateStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;

  if (type === 'success') {
    setTimeout(() => {
      statusEl.textContent = '';
      statusEl.className = 'status';
    }, 3000);
  }
}
