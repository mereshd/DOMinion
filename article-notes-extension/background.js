// ArticleNotes Background Service Worker
// Handles Gemini API communication with streaming

const GEMINI_MODEL = 'gemini-3.1-pro-preview';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const SYSTEM_PROMPT = `You are ArticleNotes, an AI assistant that helps users understand articles.
You have access to the full article content below. Answer questions about it,
explain concepts, summarize sections, or provide additional context.
You also have access to Google Search to find supplementary information when needed.

Be concise but thorough. Use markdown formatting when helpful.
Reference specific parts of the article when relevant.

ARTICLE TITLE: {title}

ARTICLE CONTENT:
{content}`;

// Port-based streaming communication
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'article-notes-chat') return;

  port.onMessage.addListener((message) => {
    if (message.action === 'chat') {
      handleStreamingChat(port, message);
    }
  });
});

async function handleStreamingChat(port, { apiKey, articleContent, articleTitle, conversationHistory }) {
  if (!apiKey) {
    port.postMessage({ type: 'error', error: 'API key not provided' });
    return;
  }

  if (!articleContent) {
    port.postMessage({ type: 'error', error: 'No article content available' });
    return;
  }

  try {
    const systemInstruction = SYSTEM_PROMPT
      .replace('{title}', articleTitle)
      .replace('{content}', articleContent);

    const contents = conversationHistory.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:streamGenerateContent?key=${apiKey}&alt=sse`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        },
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192,
          topP: 0.95,
          topK: 40,
          thinkingConfig: {
            thinkingLevel: "HIGH"
          }
        },
        tools: [{ googleSearch: {} }],
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
        ]
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData.error?.message || `API error: ${response.status}`;
      port.postMessage({ type: 'error', error: errorMessage });
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;

        try {
          const data = JSON.parse(jsonStr);
          const candidate = data.candidates?.[0];

          if (candidate?.finishReason === 'SAFETY') {
            port.postMessage({ type: 'error', error: 'Response was blocked due to safety filters.' });
            return;
          }

          const parts = candidate?.content?.parts;
          if (!parts) continue;

          for (const part of parts) {
            if (part.thought) continue;
            if (part.text) {
              port.postMessage({ type: 'chunk', text: part.text });
            }
          }
        } catch (e) {
          // Skip unparseable SSE lines
        }
      }
    }

    port.postMessage({ type: 'done' });

  } catch (error) {
    console.error('Gemini API error:', error);
    port.postMessage({ type: 'error', error: `Failed to connect to AI: ${error.message}` });
  }
}
