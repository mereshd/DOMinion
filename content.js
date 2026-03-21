// Listener for messages from the popup
chrome.runtime.onMessage.addListener((req, sender, respond) => {
  if (req.action === 'analyze') {
    console.log('[ArticleNotes] Analysis triggered');
    respond({ success: true });
  }
  return true;
});
