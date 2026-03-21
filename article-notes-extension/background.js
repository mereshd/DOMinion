// ArticleNotes Background Service Worker
// Handles Gemini API: article analysis + annotation chat

const GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const ANALYSIS_PROMPT = `Analyze the following article and identify 5-15 sections that need annotation. Use Google Search to verify claims and find additional context.

For each annotation, provide:
- "quote": EXACT verbatim substring from the article (15-100 characters). Must match the article text precisely — copy it character-for-character.
- "type": One of "fact-check", "jargon", "source", "context"
  - "fact-check": Verifiable claims, statistics, or potentially misleading statements
  - "jargon": Technical terms or complex language needing explanation
  - "source": Analysis of cited sources or references
  - "context": Important missing context or background information
- "title": Short label (3-8 words)
- "explanation": Well-researched explanation (2-4 sentences)

Guidelines:
- Distribute annotations across the entire article, not just the beginning
- Prioritize the most impactful and interesting sections
- Use Google Search to verify factual claims
- For fact-checks, clearly state whether the claim is accurate, misleading, or unverifiable
- Each quote must be unique — do not annotate the same text twice

Return ONLY a valid JSON array:
[{"quote":"...","type":"...","title":"...","explanation":"..."}]

ARTICLE TITLE: {title}

ARTICLE CONTENT:
{content}`;

const SELECTION_PROMPT = `The user selected text from an article and wants a "{type}" analysis. Use Google Search to research your answer.

Analysis types:
- "fact-check": Verify this claim. State whether it's accurate, misleading, partially true, or unverifiable. Cite sources.
- "jargon": Explain the term or concept in plain language with relevant context.
- "source": Analyze any sources, references, or claims for credibility and relevance.
- "context": Provide missing context, historical background, or alternative perspectives.

SELECTED TEXT: "{selection}"

ARTICLE TITLE: {title}

SURROUNDING ARTICLE CONTENT (for context):
{content}

Return ONLY a valid JSON object:
{"title":"Short label (3-8 words)","explanation":"Detailed, well-researched explanation (2-4 sentences)."}`;

const CHAT_SYSTEM_PROMPT = `You are ArticleNotes, an AI research assistant. The user wants to discuss a specific annotated section of an article.

Use Google Search to find additional information when helpful. Be concise but thorough. Use markdown formatting.

FULL ARTICLE TITLE: {title}

FULL ARTICLE CONTENT:
{content}

ANNOTATION CONTEXT:
Type: {type}
Original quote: "{quote}"
Your analysis: {explanation}
`;

// Non-streaming analysis + selection analysis
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'analyze') {
    handleAnalysis(message)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  if (message.action === 'analyzeSelection') {
    handleSelectionAnalysis(message)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
});

// Streaming chat via ports
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'article-notes-chat') return;
  port.onMessage.addListener((message) => {
    if (message.action === 'chat') {
      handleStreamingChat(port, message);
    }
  });
});

async function handleAnalysis({ apiKey, articleContent, articleTitle }) {
  if (!apiKey) return { error: 'API key not provided' };
  if (!articleContent) return { error: 'No article content available' };

  try {
    const prompt = ANALYSIS_PROMPT
      .replace('{title}', articleTitle)
      .replace('{content}', articleContent);

    const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192,
          topP: 0.95,
          topK: 40,
          thinkingConfig: { thinkingLevel: "HIGH" }
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
      return { error: errorData.error?.message || `API error: ${response.status}` };
    }

    const data = await response.json();

    if (data.candidates?.[0]?.finishReason === 'SAFETY') {
      return { error: 'Response was blocked due to safety filters.' };
    }

    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts) return { error: 'No response generated.' };

    let responseText = '';
    for (const part of parts) {
      if (part.thought) continue;
      if (part.text) responseText += part.text;
    }

    if (!responseText) return { error: 'No response generated.' };

    const annotations = extractJSON(responseText);
    if (!annotations) return { error: 'Failed to parse annotations. Please try again.' };

    const valid = annotations.filter(a =>
      a.quote && a.type && a.title && a.explanation &&
      ['fact-check', 'jargon', 'source', 'context'].includes(a.type)
    );

    if (valid.length === 0) return { error: 'No valid annotations found.' };

    return { annotations: valid };

  } catch (error) {
    console.error('Analysis error:', error);
    return { error: `Failed to analyze article: ${error.message}` };
  }
}

async function handleSelectionAnalysis({ apiKey, selectedText, annotationType, articleContent, articleTitle }) {
  if (!apiKey) return { error: 'API key not provided' };
  if (!selectedText) return { error: 'No text selected' };

  try {
    const prompt = SELECTION_PROMPT
      .replace('{type}', annotationType)
      .replace('{selection}', selectedText)
      .replace('{title}', articleTitle)
      .replace('{content}', articleContent);

    const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 4096,
          topP: 0.95,
          topK: 40,
          thinkingConfig: { thinkingLevel: "HIGH" }
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
      return { error: errorData.error?.message || `API error: ${response.status}` };
    }

    const data = await response.json();

    if (data.candidates?.[0]?.finishReason === 'SAFETY') {
      return { error: 'Response was blocked due to safety filters.' };
    }

    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts) return { error: 'No response generated.' };

    let responseText = '';
    for (const part of parts) {
      if (part.thought) continue;
      if (part.text) responseText += part.text;
    }

    if (!responseText) return { error: 'No response generated.' };

    const parsed = extractJSONObject(responseText);
    if (!parsed || !parsed.title || !parsed.explanation) {
      return { error: 'Failed to parse AI response.' };
    }

    return {
      annotation: {
        quote: selectedText,
        type: annotationType,
        title: parsed.title,
        explanation: parsed.explanation
      }
    };

  } catch (error) {
    console.error('Selection analysis error:', error);
    return { error: `Failed to analyze selection: ${error.message}` };
  }
}

function extractJSONObject(text) {
  try {
    const parsed = JSON.parse(text.trim());
    if (typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}

  const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlock) {
    try {
      const parsed = JSON.parse(codeBlock[1].trim());
      if (typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }

  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }

  return null;
}

function extractJSON(text) {
  try {
    const parsed = JSON.parse(text.trim());
    if (Array.isArray(parsed)) return parsed;
  } catch {}

  const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlock) {
    try {
      const parsed = JSON.parse(codeBlock[1].trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }

  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }

  return null;
}

async function handleStreamingChat(port, { apiKey, articleContent, articleTitle, annotation, conversationHistory }) {
  if (!apiKey) {
    port.postMessage({ type: 'error', error: 'API key not provided' });
    return;
  }

  try {
    const systemInstruction = CHAT_SYSTEM_PROMPT
      .replace('{type}', annotation.type)
      .replace('{quote}', annotation.quote)
      .replace('{explanation}', annotation.explanation)
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
        systemInstruction: { parts: [{ text: systemInstruction }] },
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192,
          topP: 0.95,
          topK: 40,
          thinkingConfig: { thinkingLevel: "HIGH" }
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
      port.postMessage({ type: 'error', error: errorData.error?.message || `API error: ${response.status}` });
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
            port.postMessage({ type: 'error', error: 'Response blocked by safety filters.' });
            return;
          }

          const parts = candidate?.content?.parts;
          if (!parts) continue;

          for (const part of parts) {
            if (part.thought) continue;
            if (part.text) port.postMessage({ type: 'chunk', text: part.text });
          }
        } catch (e) {}
      }
    }

    port.postMessage({ type: 'done' });

  } catch (error) {
    console.error('Chat error:', error);
    port.postMessage({ type: 'error', error: `Failed to connect: ${error.message}` });
  }
}
