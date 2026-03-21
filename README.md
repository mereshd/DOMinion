<div align="center">
  <img src="assets/dominion_logo.webp" alt="DOMinion logo" width="220" />
</div>

# DOMinion

AI-powered Chrome extension that analyzes web articles and annotates them inline with fact-checks, context, explanations, and source analysis.

## Features

- **Smart Highlights** — Automatically identifies claims, jargon, sources, and missing context in any article
- **Research Tooltips** — Hover any highlight to see AI-generated analysis backed by Google Search
- **Deep Chat** — Click any annotation to open a chat panel for follow-up questions
- **Selection Analysis** — Select any text and choose an annotation type from the context menu
- **Annotations TOC** — Floating table of contents listing all annotations with click-to-scroll
- **Persistent Cache** — Annotations, chat history, and user highlights survive page refresh and browser restart
- **Dismiss & Clear** — Remove individual annotations or clear all at once
- **Model Selection** — Choose between Flash Lite (fast) and Pro (thorough) Gemini models

## Setup

1. Clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the **repository root** (the folder that contains `manifest.json`, not `extension/` alone)
5. Click the DOMinion icon in the toolbar
6. Enter your [Gemini API key](https://aistudio.google.com/app/apikey) and save
7. Navigate to any article and click **Annotate This Page**

## Tech Stack

- Chrome Extension Manifest V3
- Gemini API (gemini-3.1-pro-preview / gemini-3.1-flash-lite-preview)
- Google Search grounding + thinking mode
- Turndown.js for HTML-to-Markdown extraction
- Shadow DOM for style-isolated overlay UI
- `chrome.storage.local` for annotation persistence

## Project Structure

```
manifest.json        Extension manifest (Chrome loads the repo root)
assets/              Shared assets (e.g. dominion_fig_logo.webp for web_accessible_resources)
extension/           Extension scripts, popup, icons, and bundled libraries
  background.js      Gemini API service worker
  content.js         Annotations, tooltips, chat, TOC, persistence
  content.css        Inline highlight styles
  popup.html/css/js  Extension popup UI
  turndown.js        HTML-to-Markdown converter
  icons/             Extension icons
```
