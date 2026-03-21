// ArticleNotes Background Service Worker
// Handles Gemini API communication

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent';

// System prompt template
const SYSTEM_PROMPT = `You are ArticleNotes, an AI assistant that helps users understand articles.
You have access to the full article content below. Answer questions about it,
explain concepts, summarize sections, or provide additional context.

Be concise but thorough. Use markdown formatting when helpful.
Reference specific parts of the article when relevant.

ARTICLE TITLE: {title}

ARTICLE CONTENT:
{content}`;

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'chat') {
    handleChatMessage(message)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true; // Keep channel open for async response
  }
});

// Handle chat message
async function handleChatMessage({ apiKey, articleContent, articleTitle, conversationHistory }) {
  if (!apiKey) {
    return { error: 'API key not provided' };
  }

  if (!articleContent) {
    return { error: 'No article content available' };
  }

  try {
    // Build the system instruction with article content
    const systemInstruction = SYSTEM_PROMPT
      .replace('{title}', articleTitle)
      .replace('{content}', articleContent);

    // Build conversation contents for Gemini API
    const contents = conversationHistory.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    // Make API request
    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: contents,
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        },
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048,
          topP: 0.95,
          topK: 40
        },
        safetySettings: [
          {
            category: 'HARM_CATEGORY_HARASSMENT',
            threshold: 'BLOCK_ONLY_HIGH'
          },
          {
            category: 'HARM_CATEGORY_HATE_SPEECH',
            threshold: 'BLOCK_ONLY_HIGH'
          },
          {
            category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
            threshold: 'BLOCK_ONLY_HIGH'
          },
          {
            category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
            threshold: 'BLOCK_ONLY_HIGH'
          }
        ]
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData.error?.message || `API error: ${response.status}`;
      return { error: errorMessage };
    }

    const data = await response.json();

    // Extract the response text
    if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
      return { text: data.candidates[0].content.parts[0].text };
    }

    // Check for blocked content
    if (data.candidates && data.candidates[0]?.finishReason === 'SAFETY') {
      return { error: 'Response was blocked due to safety filters.' };
    }

    return { error: 'No response generated. Please try again.' };

  } catch (error) {
    console.error('Gemini API error:', error);
    return { error: `Failed to connect to AI: ${error.message}` };
  }
}
