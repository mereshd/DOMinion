# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DOMinion is a Chrome extension (Manifest V3) that uses the Gemini API to analyze web articles and add inline annotations with fact-checks, explanations, source analysis, and context. It uses Google Search grounding for research.

## Development Setup

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode**
3. Click **Load unpacked** and select the **repository root** (contains `manifest.json`)
4. After making changes, click the refresh icon on the extension card to reload

No build step is required - this is a vanilla JS extension loaded directly.

## Architecture

### Core Components

- **background.js** - Service worker handling Gemini API calls:
  - `handleAnalysis()` - Full article analysis returning JSON array of annotations
  - `handleSelectionAnalysis()` - Analyzes user-selected text
  - `handleStreamingChat()` - Streaming chat via Chrome ports for follow-up questions

- **content.js** - Content script (~1500 lines) managing:
  - Article extraction via Turndown.js (HTML → Markdown)
  - DOM highlighting with `<mark>` elements
  - Shadow DOM overlay for UI isolation (tooltips, chat panel, TOC, selection menu)
  - Persistence via `chrome.storage.local` keyed by normalized URL

- **popup.js** - Extension popup for API key configuration and triggering analysis

### Communication Flow

1. Popup sends `analyzeArticle` message to content script
2. Content script extracts article, sends to background via `chrome.runtime.sendMessage`
3. Background calls Gemini API with Google Search grounding enabled
4. Background returns JSON annotations; content script highlights matching quotes in DOM

### Data Persistence

Annotations are cached in `chrome.storage.local` with key format `an:{normalized_url}`. Cache includes:
- Annotations array with `id`, `quote`, `type`, `title`, `explanation`, `chatHistory`
- Dismissed annotation IDs
- Article markdown

### Annotation Types

Four types defined in `ANNOTATION_META`: `fact-check`, `jargon`, `source`, `context`

## Key Implementation Details

- Quotes must match article text exactly for highlighting to work
- Chat uses streaming via `chrome.runtime.connect()` with port name `dominion-chat`
- Shadow DOM at `#dominion-overlay` isolates all overlay styles from page CSS
- Turndown with GFM plugin converts article HTML to markdown for API context
