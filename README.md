# Local AI

A minimal black-and-white desktop application for local coding assistance with Ollama. It allows you to:

- select a project folder
- browse files in a sidebar
- chat with a locally running Ollama model
- attach a selected file as code context
- generate JSON-based proposals to edit existing project files
- review diffs and approve edits before any files are written
- reset the current conversation safely

## Requirements

- Node.js 20+
- Rust and Cargo
- Ollama running locally at http://localhost:11434

## Installation

```bash
npm install
```

## Run in development mode

```bash
npm run dev
```

For the desktop Tauri app:

```bash
npx tauri dev
```

## Build

```bash
npm run build
npx tauri build
```

## Test

```bash
npm test
```

## Security notes

- All file proposals are validated against relative path and project-root rules.
- Proposal mode only edits existing files; it does not create or delete files.
- Model edits use exact JSON text replacements that preserve the rest of each file.
- Existing file contents and hashes are captured for review and stale-file checks.
- The app rejects traversal attempts such as `../`.
- Approval is required before writing any file.
- No model-generated code is executed automatically.

## Configure Ollama

Ensure Ollama is installed and running locally. Then set the base URL in the app or use the default:

```text
http://localhost:11434
```
