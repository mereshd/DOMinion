// DOMinion Background Service Worker
// Handles multi-provider API: article analysis + annotation chat

// ============================================================
// Prompt Templates
// ============================================================

const ANALYSIS_PROMPT_GROUNDED = `Analyze the following article and identify 5-15 sections that need annotation. Use Google Search to verify claims and find additional context.

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

const ANALYSIS_PROMPT_GENERIC = `Analyze the following article and identify 5-15 sections that need annotation. Verify claims and provide additional context using your knowledge.

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
- For fact-checks, clearly state whether the claim is accurate, misleading, or unverifiable
- Each quote must be unique — do not annotate the same text twice

Return ONLY a valid JSON array:
[{"quote":"...","type":"...","title":"...","explanation":"..."}]

ARTICLE TITLE: {title}

ARTICLE CONTENT:
{content}`;

const SELECTION_PROMPT_GROUNDED = `The user selected text from an article and wants a "{type}" analysis. Use Google Search to research your answer.

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

const SELECTION_PROMPT_GENERIC = `The user selected text from an article and wants a "{type}" analysis. Research and verify your answer thoroughly.

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

const CHAT_SYSTEM_GROUNDED = `You are DOMinion, an AI research assistant. The user wants to discuss a specific annotated section of an article.

Use Google Search to find additional information when helpful. Be concise but thorough. Use markdown formatting.

FULL ARTICLE TITLE: {title}

FULL ARTICLE CONTENT:
{content}

ANNOTATION CONTEXT:
Type: {type}
Original quote: "{quote}"
Your analysis: {explanation}
`;

const CHAT_SYSTEM_GENERIC = `You are DOMinion, an AI research assistant. The user wants to discuss a specific annotated section of an article.

Be concise but thorough. Use markdown formatting.

FULL ARTICLE TITLE: {title}

FULL ARTICLE CONTENT:
{content}

ANNOTATION CONTEXT:
Type: {type}
Original quote: "{quote}"
Your analysis: {explanation}
`;

// ============================================================
// Provider Implementations
// ============================================================

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_SAFETY = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
];

const geminiProvider = {
  defaultModel: 'gemini-3.1-flash-lite-preview',

  analysisPrompt: ANALYSIS_PROMPT_GROUNDED,
  selectionPrompt: SELECTION_PROMPT_GROUNDED,
  chatSystemPrompt: CHAT_SYSTEM_GROUNDED,

  buildRequest(apiKey, model, prompt, maxTokens) {
    return {
      url: `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`,
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: maxTokens,
            topP: 0.95,
            topK: 40,
            thinkingConfig: { thinkingLevel: 'HIGH' }
          },
          tools: [{ googleSearch: {} }],
          safetySettings: GEMINI_SAFETY
        })
      }
    };
  },

  extractText(data) {
    if (data.candidates?.[0]?.finishReason === 'SAFETY') {
      return { error: 'Response was blocked due to safety filters.' };
    }
    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts) return { error: 'No response generated.' };
    let text = '';
    for (const part of parts) {
      if (part.thought) continue;
      if (part.text) text += part.text;
    }
    return text ? { text } : { error: 'No response generated.' };
  },

  buildStreamRequest(apiKey, model, systemPrompt, messages) {
    const contents = messages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));
    return {
      url: `${GEMINI_API_BASE}/${model}:streamGenerateContent?key=${apiKey}&alt=sse`,
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: systemPrompt }] },
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 8192,
            topP: 0.95,
            topK: 40,
            thinkingConfig: { thinkingLevel: 'HIGH' }
          },
          tools: [{ googleSearch: {} }],
          safetySettings: GEMINI_SAFETY
        })
      }
    };
  },

  parseStreamChunk(jsonStr) {
    const data = JSON.parse(jsonStr);
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason === 'SAFETY') {
      return { error: 'Response blocked by safety filters.' };
    }
    const parts = candidate?.content?.parts;
    if (!parts) return {};
    let text = '';
    for (const part of parts) {
      if (part.thought) continue;
      if (part.text) text += part.text;
    }
    return text ? { text } : {};
  }
};

const openaiProvider = {
  defaultModel: 'gpt-5.4-nano',

  analysisPrompt: ANALYSIS_PROMPT_GENERIC,
  selectionPrompt: SELECTION_PROMPT_GENERIC,
  chatSystemPrompt: CHAT_SYSTEM_GENERIC,

  buildRequest(apiKey, model, prompt, maxTokens) {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      options: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7,
          max_completion_tokens: maxTokens
        })
      }
    };
  },

  extractText(data) {
    if (data.error) {
      return { error: data.error.message || 'OpenAI API error' };
    }
    const text = data.choices?.[0]?.message?.content;
    return text ? { text } : { error: 'No response generated.' };
  },

  buildStreamRequest(apiKey, model, systemPrompt, messages) {
    const msgs = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content }))
    ];
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      options: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: msgs,
          temperature: 0.7,
          max_completion_tokens: 8192,
          stream: true
        })
      }
    };
  },

  parseStreamChunk(jsonStr) {
    const data = JSON.parse(jsonStr);
    const delta = data.choices?.[0]?.delta;
    if (delta?.content) return { text: delta.content };
    return {};
  }
};

const claudeProvider = {
  defaultModel: 'claude-haiku-4-5',

  analysisPrompt: ANALYSIS_PROMPT_GENERIC,
  selectionPrompt: SELECTION_PROMPT_GENERIC,
  chatSystemPrompt: CHAT_SYSTEM_GENERIC,

  buildRequest(apiKey, model, prompt, maxTokens) {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      options: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.7
        })
      }
    };
  },

  extractText(data) {
    if (data.type === 'error') {
      return { error: data.error?.message || 'Anthropic API error' };
    }
    if (data.stop_reason === 'max_tokens') {
      // Still usable, just truncated
    }
    const block = data.content?.find(b => b.type === 'text');
    return block?.text ? { text: block.text } : { error: 'No response generated.' };
  },

  buildStreamRequest(apiKey, model, systemPrompt, messages) {
    const msgs = messages.map(m => ({ role: m.role, content: m.content }));
    return {
      url: 'https://api.anthropic.com/v1/messages',
      options: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model,
          system: systemPrompt,
          messages: msgs,
          max_tokens: 8192,
          temperature: 0.7,
          stream: true
        })
      }
    };
  },

  parseStreamChunk(jsonStr) {
    const data = JSON.parse(jsonStr);
    if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
      return { text: data.delta.text };
    }
    if (data.type === 'error') {
      return { error: data.error?.message || 'Stream error' };
    }
    return {};
  }
};

const PROVIDERS = { gemini: geminiProvider, openai: openaiProvider, claude: claudeProvider };

function getProvider(name) {
  return PROVIDERS[name] || geminiProvider;
}

// ============================================================
// Message Listeners
// ============================================================

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

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'dominion-chat') return;
  port.onMessage.addListener((message) => {
    if (message.action === 'chat') {
      handleStreamingChat(port, message);
    }
  });
});

// ============================================================
// Handlers
// ============================================================

async function handleAnalysis({ apiKey, model, provider: providerName, articleContent, articleTitle }) {
  if (!apiKey) return { error: 'API key not provided' };
  if (!articleContent) return { error: 'No article content available' };

  const provider = getProvider(providerName);
  const resolvedModel = model || provider.defaultModel;

  try {
    const prompt = provider.analysisPrompt
      .replace('{title}', articleTitle)
      .replace('{content}', articleContent);

    const { url, options } = provider.buildRequest(apiKey, resolvedModel, prompt, 8192);
    const response = await fetch(url, options);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const msg = errorData.error?.message || `API error: ${response.status}`;
      return { error: msg };
    }

    const data = await response.json();
    const result = provider.extractText(data);
    if (result.error) return { error: result.error };

    const annotations = extractJSON(result.text);
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

async function handleSelectionAnalysis({ apiKey, model, provider: providerName, selectedText, annotationType, articleContent, articleTitle }) {
  if (!apiKey) return { error: 'API key not provided' };
  if (!selectedText) return { error: 'No text selected' };

  const provider = getProvider(providerName);
  const resolvedModel = model || provider.defaultModel;

  try {
    const prompt = provider.selectionPrompt
      .replace('{type}', annotationType)
      .replace('{selection}', selectedText)
      .replace('{title}', articleTitle)
      .replace('{content}', articleContent);

    const { url, options } = provider.buildRequest(apiKey, resolvedModel, prompt, 4096);
    const response = await fetch(url, options);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return { error: errorData.error?.message || `API error: ${response.status}` };
    }

    const data = await response.json();
    const result = provider.extractText(data);
    if (result.error) return { error: result.error };

    const parsed = extractJSONObject(result.text);
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

async function handleStreamingChat(port, { apiKey, model, provider: providerName, articleContent, articleTitle, annotation, conversationHistory }) {
  if (!apiKey) {
    port.postMessage({ type: 'error', error: 'API key not provided' });
    return;
  }

  const provider = getProvider(providerName);
  const resolvedModel = model || provider.defaultModel;

  try {
    const systemPrompt = provider.chatSystemPrompt
      .replace('{type}', annotation.type)
      .replace('{quote}', annotation.quote)
      .replace('{explanation}', annotation.explanation)
      .replace('{title}', articleTitle)
      .replace('{content}', articleContent);

    const { url, options } = provider.buildStreamRequest(apiKey, resolvedModel, systemPrompt, conversationHistory);
    const response = await fetch(url, options);

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
        if (line.startsWith('event:')) continue;

        if (!line.startsWith('data: ') && !line.startsWith('data:')) continue;
        const jsonStr = line.replace(/^data:\s?/, '').trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;

        try {
          const chunk = provider.parseStreamChunk(jsonStr);
          if (chunk.error) {
            port.postMessage({ type: 'error', error: chunk.error });
            return;
          }
          if (chunk.text) {
            port.postMessage({ type: 'chunk', text: chunk.text });
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

// ============================================================
// JSON Extraction Helpers
// ============================================================

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
