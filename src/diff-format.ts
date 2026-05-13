const HTML_TITLE = "Codex Diff";
const HTML_STYLE = [
  ":root {",
  "  color-scheme: light dark;",
  "  --bg: #fafafa;",
  "  --text: #1f2937;",
  "  --muted: #64748b;",
  "  --border: #d8dee4;",
  "  --add-bg: #e6ffed;",
  "  --add-text: #116329;",
  "  --del-bg: #ffebe9;",
  "  --del-text: #82071e;",
  "  --hunk-bg: #eef4ff;",
  "  --hunk-text: #0550ae;",
  "  --meta-bg: #f6f8fa;",
  "}",
  "@media (prefers-color-scheme: dark) {",
  "  :root {",
  "    --bg: #0d1117;",
  "    --text: #e6edf3;",
  "    --muted: #8b949e;",
  "    --border: #30363d;",
  "    --add-bg: #12261f;",
  "    --add-text: #7ee787;",
  "    --del-bg: #2d1518;",
  "    --del-text: #ffa198;",
  "    --hunk-bg: #102542;",
  "    --hunk-text: #79c0ff;",
  "    --meta-bg: #161b22;",
  "  }",
  "}",
  "body {",
  "  margin: 0;",
  "  background: var(--bg);",
  "  color: var(--text);",
  "  font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;",
  "  line-height: 1.45;",
  "}",
  "header {",
  "  position: sticky;",
  "  top: 0;",
  "  padding: 12px 14px;",
  "  border-bottom: 1px solid var(--border);",
  "  background: var(--bg);",
  "}",
  "h1 {",
  "  margin: 0;",
  "  font-size: 15px;",
  "  font-weight: 650;",
  "}",
  ".diff { padding: 8px 0 20px; }",
  ".line {",
  "  display: block;",
  "  padding: 2px 12px;",
  "  white-space: pre-wrap;",
  "  overflow-wrap: anywhere;",
  "  border-left: 4px solid transparent;",
  "}",
  ".line.meta {",
  "  background: var(--meta-bg);",
  "  color: var(--muted);",
  "  font-weight: 650;",
  "}",
  ".line.hunk {",
  "  background: var(--hunk-bg);",
  "  color: var(--hunk-text);",
  "  border-left-color: var(--hunk-text);",
  "}",
  ".line.add {",
  "  background: var(--add-bg);",
  "  color: var(--add-text);",
  "  border-left-color: var(--add-text);",
  "}",
  ".line.del {",
  "  background: var(--del-bg);",
  "  color: var(--del-text);",
  "  border-left-color: var(--del-text);",
  "}",
].join("\n");

export function renderDiffHtml(diff: string): string {
  const rows = diff.split(/\r?\n/).map(renderDiffLine).join("\n");

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${HTML_TITLE}</title>`,
    "<style>",
    HTML_STYLE,
    "</style>",
    "</head>",
    "<body>",
    `<header><h1>${HTML_TITLE}</h1></header>`,
    `<main class="diff">${rows}</main>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function renderDiffLine(line: string): string {
  return `<span class="line ${diffLineClass(line)}">${escapeHtml(line)}</span>`;
}

function diffLineClass(line: string): string {
  if (line.startsWith("diff --git") || line.startsWith("index ")) {
    return "meta";
  }

  if (line.startsWith("@@")) {
    return "hunk";
  }

  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "add";
  }

  if (line.startsWith("-") && !line.startsWith("---")) {
    return "del";
  }

  if (line.startsWith("---") || line.startsWith("+++")) {
    return "meta";
  }

  return "context";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
