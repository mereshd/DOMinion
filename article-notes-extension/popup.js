// DOM Elements
const apiKeyInput = document.getElementById('api-key');
const toggleVisibilityBtn = document.getElementById('toggle-visibility');
const saveKeyBtn = document.getElementById('save-key');
const analyzeBtn = document.getElementById('analyze-btn');
const statusEl = document.getElementById('status');
const iconEye = document.querySelector('.icon-eye');
const iconEyeOff = document.querySelector('.icon-eye-off');

// State
let isKeyVisible = false;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await loadApiKey();
});

// Load saved API key
async function loadApiKey() {
  try {
    const result = await chrome.storage.sync.get(['geminiApiKey']);
    if (result.geminiApiKey) {
      apiKeyInput.value = result.geminiApiKey;
      updateStatus('API key loaded', 'success');
      analyzeBtn.disabled = false;
    }
  } catch (error) {
    console.error('Error loading API key:', error);
  }
}

// Save API key
saveKeyBtn.addEventListener('click', async () => {
  const apiKey = apiKeyInput.value.trim();
  
  if (!apiKey) {
    updateStatus('Please enter an API key', 'error');
    return;
  }

  try {
    await chrome.storage.sync.set({ geminiApiKey: apiKey });
    updateStatus('API key saved successfully', 'success');
    analyzeBtn.disabled = false;
  } catch (error) {
    updateStatus('Error saving API key', 'error');
    console.error('Error saving API key:', error);
  }
});

// Toggle password visibility
toggleVisibilityBtn.addEventListener('click', () => {
  isKeyVisible = !isKeyVisible;
  apiKeyInput.type = isKeyVisible ? 'text' : 'password';
  iconEye.classList.toggle('hidden', isKeyVisible);
  iconEyeOff.classList.toggle('hidden', !isKeyVisible);
});

// Analyze current page
analyzeBtn.addEventListener('click', async () => {
  try {
    // Get the current active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab) {
      updateStatus('No active tab found', 'error');
      return;
    }

    // Check if we can inject into this tab
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      updateStatus('Cannot analyze browser pages', 'error');
      return;
    }

    // Send message to content script to open the modal
    await chrome.tabs.sendMessage(tab.id, { action: 'openArticleNotes' });
    
    // Close the popup
    window.close();
  } catch (error) {
    updateStatus('Error: Refresh the page and try again', 'error');
    console.error('Error:', error);
  }
});

// Update status message
function updateStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  
  // Clear status after 3 seconds for success messages
  if (type === 'success') {
    setTimeout(() => {
      statusEl.textContent = '';
      statusEl.className = 'status';
    }, 3000);
  }
}
