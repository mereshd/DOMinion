const $ = id => document.getElementById(id);
const status = (msg, typ = '') => { $('status').textContent = msg; $('status').className = typ; };

async function load() {
  const s = await chrome.storage.sync.get({ apiKey: '' });
  $('apiKey').value = s.apiKey;
}

async function saveKey() {
  await chrome.storage.sync.set({ apiKey: $('apiKey').value });
}

async function analyze() {
  $('analyze').disabled = true;
  await saveKey();

  const key = $('apiKey').value.trim();
  if (!key) { status('Please enter an API key.', 'error'); $('analyze').disabled = false; return; }

  status('Analyzing page...');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Tell the content script to start analysis
    await chrome.tabs.sendMessage(tab.id, { action: 'analyze', apiKey: key });
    status('✓ Analysis started!', 'success');
  } catch (err) {
    status(`Error: ${err.message}`, 'error');
  }

  $('analyze').disabled = false;
}

document.addEventListener('DOMContentLoaded', load);
$('apiKey').addEventListener('change', saveKey);
$('analyze').addEventListener('click', analyze);
