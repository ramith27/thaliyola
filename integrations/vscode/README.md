# Thaliyola for VS Code

A side panel (**Explorer › Thaliyola**) with what your team knows about the file you're editing, from your Thaliyola server:

- **Rules for agents** that apply to it (read first, never edit, heads-up).
- **Documented facts** that cite its lines. Those lines are marked in the editor, with the fact on hover; a fact that no longer matches the code says so.
- **Docs, contracts** (and who consumes them), **known issues** and **vulnerabilities** about it, and **other sessions** working on it right now.

Click an entry to open it in Thaliyola. The panel follows the file you're on and refreshes when you save.

## Install

```sh
cd integrations/vscode
npx @vscode/vsce package          # makes thaliyola-0.1.0.vsix
code --install-extension thaliyola-0.1.0.vsix
```

Then set **thaliyola.url** in Settings (your server, e.g. `https://kb.example.com`) and run **Thaliyola: Set access token** with a personal API token from Thaliyola's Account page. The token is kept in VS Code's secret storage.

It finds the project from the file's git remote (`origin`), so the repository must be one of a project's repositories in Thaliyola, and you only see projects you can read.
