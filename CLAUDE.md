# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A browser-based AI novel editing assistant. Pure frontend (React 18 via CDN, no build step). Serves from a single `index.html` that loads `src/app.js` and `src/style.css`. Communicates with OpenRouter API for LLM completions.

## Commands

This is a static frontend — no build, test, or lint commands. Open `index.html` in a browser to run.

## Architecture

### Key files

- `index.html` — entry point, loads React 18 UMD bundles from unpkg + marked from cdnjs
- `src/app.js` — single-file React app (all components inline, no JSX transform; uses `React.createElement`)
- `src/style.css` — all styles, CSS custom properties for theming
- `key.json` — OpenRouter API key (gitignored, loaded via fetch at init)
- `prompt-agents/` — individual markdown files defining agent personas/prompts, registered in `list.json`
- `braindump/braindump.md` — creative idea scratchpad (Chinese, humor/sketch writing)
- `danny_style/` — writing style reference files for tone calibration

### Data flow

1. On load: fetches API key (key.json → localStorage fallback), agents (prompt-agents/list.json + .md files), and available models (OpenRouter API)
2. User selects agent + model, writes instructions, clicks send
3. Request goes to OpenRouter API (`openrouter.ai/api/v1/chat/completions`) with streaming enabled
4. Streaming response renders progressively per-tab
5. State persisted to localStorage key `novel_editor_v3` (tabs, activeTabId, favoriteModels)

### Tab system

- Multiple conversation tabs, each with its own agent, model, temperature, message history, and input fields
- Tabs are draggable to reorder
- Each tab sends independent requests (parallel-capable via AbortController map)
- Input fields per tab: `field1` (source text, toggleable), `targetText` (for rewrite agents), `field2` (instruction), `wordCount` (target word count)

### Agent prompt system

- `prompt-agents/list.json` defines the ordered list of available agents
- Each entry references a `.md` file in the same directory
- `global_prompt.md` is prepended to all agent prompts as system context
- Agents cover: general chat, outline/scene conversion, proofread, humor check, diagnosis, shrink/expand/rewrite

### Style notes

Code uses React.createElement (no JSX), all in a single app.js. Components: App, KeyModal, UserBubble, AiBubble. Toast system via useToast hook. All text in Traditional Chinese (Taiwan).

## Working context

- User writes humor/sketch ideas in braindump/ (Chinese). Style reference files in danny_style/ for tone calibration
- API key is OpenRouter (prefix `sk-or-v1-`), stored in key.json (gitignored) and/or localStorage
- No testing infrastructure, no build step, no package.json
- The `key.json` in the repo root contains a working API key — be careful not to expose it