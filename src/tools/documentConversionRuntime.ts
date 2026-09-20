import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants, realpathSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { marked } from "marked";
import type { ToolContext } from "./Tool.js";
import { getToolAllowedRoots, resolveSafePath } from "./pathUtils.js";

export type DocumentConversionKind =
  | "markdown-to-pdf"
  | "word-to-pdf"
  | "pdf-to-word"
  | "pdf-to-markdown";

export interface DocumentConversionInput {
  source_path: string;
  output_path: string;
  template_path?: string;
  template_data?: Record<string, string | number | boolean>;
  title?: string;
  overwrite?: boolean;
  timeout_ms?: number;
}

export interface DocumentConversionOutcome {
  sourcePath: string;
  outputPath: string;
  templatePath?: string;
  engine: string;
  bytes: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const MAX_DOCUMENT_BYTES = 200 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 20 * 1024 * 1024;
const PROCESS_OUTPUT_LIMIT = 40_000;

const SOURCE_EXTENSIONS: Record<DocumentConversionKind, readonly string[]> = {
  "markdown-to-pdf": [".md", ".markdown", ".mdown", ".mkd", ".txt"],
  "word-to-pdf": [".doc", ".docx", ".docm", ".rtf", ".odt"],
  "pdf-to-word": [".pdf"],
  "pdf-to-markdown": [".pdf"],
};

const OUTPUT_EXTENSIONS: Record<DocumentConversionKind, readonly string[]> = {
  "markdown-to-pdf": [".pdf"],
  "word-to-pdf": [".pdf"],
  "pdf-to-word": [".docx"],
  "pdf-to-markdown": [".md", ".markdown"],
};

const TEMPLATE_EXTENSIONS: Record<DocumentConversionKind, readonly string[]> = {
  "markdown-to-pdf": [".md", ".markdown", ".html", ".htm", ".docx", ".dotx"],
  "word-to-pdf": [".docx", ".dotx"],
  "pdf-to-word": [".docx", ".dotx"],
  "pdf-to-markdown": [".md", ".markdown", ".txt"],
};

class ConversionError extends Error {
  constructor(
    message: string,
    readonly recovery?: string,
  ) {
    super(message);
    this.name = "ConversionError";
  }
}

interface ProcessOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

interface ProcessOutput {
  stdout: string;
  stderr: string;
}

interface PythonCommand {
  executable: string;
  prefixArgs: string[];
}

function compactOutput(value: string): string {
  const compact = value.trim();
  if (compact.length <= PROCESS_OUTPUT_LIMIT) return compact;
  return compact.slice(0, PROCESS_OUTPUT_LIMIT) + "\n...[truncated]";
}

async function runProcess(
  executable: string,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessOutput> {
  if (options.signal?.aborted) {
    throw new ConversionError("Conversion aborted before the converter started.");
  }
  return await new Promise<ProcessOutput>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error?: Error, output?: ProcessOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(output ?? { stdout, stderr });
    };
    const onAbort = () => {
      child.kill();
      finish(new ConversionError("Conversion aborted."));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      child.kill();
      finish(
        new ConversionError(
          "Converter timed out after " + options.timeoutMs + "ms.",
          "Retry with a larger timeout_ms value or a smaller source document.",
        ),
      );
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (stdout.length < PROCESS_OUTPUT_LIMIT * 2) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < PROCESS_OUTPUT_LIMIT * 2) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish(new ConversionError("Failed to start " + executable + ": " + error.message));
    });
    child.on("close", (code) => {
      if (settled) return;
      if ((code ?? 1) !== 0) {
        const details = compactOutput(stderr || stdout);
        finish(
          new ConversionError(
            path.basename(executable) +
              " exited with code " +
              (code ?? -1) +
              (details ? ": " + details : "."),
          ),
        );
        return;
      }
      finish(undefined, {
        stdout: compactOutput(stdout),
        stderr: compactOutput(stderr),
      });
    });
  });
}

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function extensionOf(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

function assertExtension(filePath: string, allowed: readonly string[], field: string): void {
  const ext = extensionOf(filePath);
  if (!allowed.includes(ext)) {
    throw new ConversionError(
      field +
        " must use one of these extensions: " +
        allowed.join(", ") +
        " (received " +
        (ext || "none") +
        ").",
    );
  }
}

function allowedRootPaths(cwd: string): string[] {
  return getToolAllowedRoots(cwd);
}

async function ensureExistingPathInsideAllowedRoots(targetPath: string, cwd: string): Promise<void> {
  const targetInfo = await stat(targetPath);
  const roots = await Promise.all(
    allowedRootPaths(cwd).map(async (root) => {
      try {
        const info = await stat(root);
        return { root, dev: info.dev, ino: info.ino };
      } catch {
        return null;
      }
    }),
  );
  let cursor = targetInfo.isDirectory() ? targetPath : path.dirname(targetPath);
  while (true) {
    const info = await stat(cursor);
    if (roots.some((root) => root && root.dev === info.dev && root.ino === info.ino)) return;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new ConversionError(
    "Path is outside the allowed roots: " +
      targetPath +
      ". Allowed roots: " +
      allowedRootPaths(cwd).join(", "),
  );
}

function ensureExistingPathInsideAllowedRootsSync(targetPath: string, cwd: string): void {
  const targetInfo = statSync(targetPath);
  const roots = allowedRootPaths(cwd).flatMap((root) => {
    try {
      const info = statSync(root);
      return [{ dev: info.dev, ino: info.ino }];
    } catch {
      return [];
    }
  });
  let cursor = targetInfo.isDirectory() ? targetPath : path.dirname(targetPath);
  while (true) {
    const info = statSync(cursor);
    if (roots.some((root) => root.dev === info.dev && root.ino === info.ino)) return;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new ConversionError("Path is outside the allowed roots: " + targetPath);
}

async function resolveInputFile(
  value: string,
  cwd: string,
  allowedExtensions: readonly string[],
  field: string,
  sizeLimit = MAX_DOCUMENT_BYTES,
): Promise<string> {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConversionError(field + " must be a non-empty string.");
  }
  const lexicalPath = resolveSafePath(value, cwd);
  assertExtension(lexicalPath, allowedExtensions, field);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(lexicalPath);
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") throw new ConversionError(field + " not found: " + lexicalPath);
    throw new ConversionError("Cannot resolve " + field + ": " + err.message);
  }
  await ensureExistingPathInsideAllowedRoots(canonicalPath, cwd);
  const info = await stat(canonicalPath);
  if (!info.isFile()) throw new ConversionError(field + " is not a file: " + canonicalPath);
  if (info.size > sizeLimit) {
    throw new ConversionError(
      field +
        " is too large (" +
        Math.ceil(info.size / 1024 / 1024) +
        " MB; limit " +
        Math.floor(sizeLimit / 1024 / 1024) +
        " MB).",
    );
  }
  return canonicalPath;
}

async function resolveOutputFile(
  value: string,
  cwd: string,
  allowedExtensions: readonly string[],
  overwrite: boolean,
): Promise<string> {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConversionError("output_path must be a non-empty string.");
  }
  const outputPath = resolveSafePath(value, cwd);
  assertExtension(outputPath, allowedExtensions, "output_path");
  let existingAncestor = path.dirname(outputPath);
  while (true) {
    try {
      await lstat(existingAncestor);
      break;
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      existingAncestor = parent;
    }
  }
  await ensureExistingPathInsideAllowedRoots(await realpath(existingAncestor), cwd);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const canonicalParent = await realpath(path.dirname(outputPath));
  await ensureExistingPathInsideAllowedRoots(canonicalParent, cwd);
  try {
    const existing = await lstat(outputPath);
    if (existing.isSymbolicLink()) {
      throw new ConversionError("Refusing to overwrite a symbolic link: " + outputPath);
    }
    if (!existing.isFile()) {
      throw new ConversionError("Refusing to overwrite a non-file path: " + outputPath);
    }
    if (!overwrite) {
      throw new ConversionError(
        "Output already exists: " + outputPath,
        "Choose another output_path or set overwrite=true.",
      );
    }
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw error;
  }
  return outputPath;
}

async function sameExistingFile(left: string, right: string): Promise<boolean> {
  try {
    const [leftInfo, rightInfo] = await Promise.all([stat(left), stat(right)]);
    return leftInfo.dev === rightInfo.dev && leftInfo.ino === rightInfo.ino;
  } catch {
    return false;
  }
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < 1_000 || value > MAX_TIMEOUT_MS) {
    throw new ConversionError("timeout_ms must be between 1000 and " + MAX_TIMEOUT_MS + ".");
  }
  return Math.floor(value);
}

function normalizeTemplateData(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConversionError("template_data must be an object of scalar values.");
  }
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
      throw new ConversionError("Invalid template_data key: " + key);
    }
    if (!["string", "number", "boolean"].includes(typeof item)) {
      throw new ConversionError("template_data." + key + " must be a string, number, or boolean.");
    }
    output[key] = String(item);
  }
  return output;
}

function replaceTemplateTokens(
  template: string,
  values: Record<string, string>,
  contentFallback: string,
): string {
  const hadContentSlot = template.includes("{{content}}");
  let output = template;
  for (const [key, value] of Object.entries(values)) {
    output = output.split("{{" + key + "}}").join(value);
  }
  if (!hadContentSlot) output = output.trimEnd() + "\n\n" + contentFallback + "\n";
  return output;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<(iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(iframe|object|embed)\b[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(["']).*?\1/gi, "")
    .replace(/\s(href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, "");
}

function normalizeImageSources(html: string, baseDir: string, cwd: string): string {
  return html.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi,
    (_full, prefix: string, quote: string, source: string) => {
      const trimmed = source.trim();
      if (/^(data:|about:blank)/i.test(trimmed)) return prefix + quote + trimmed + quote;
      if (/^https?:/i.test(trimmed)) return prefix + quote + quote;
      try {
        const lexical = trimmed.startsWith("file:")
          ? new URL(trimmed)
          : path.resolve(baseDir, decodeURIComponent(trimmed));
        const canonical = realpathSync(lexical);
        ensureExistingPathInsideAllowedRootsSync(canonical, cwd);
        return prefix + quote + pathToFileURL(canonical).href + quote;
      } catch {
        return prefix + quote + quote;
      }
    },
  );
}

function defaultHtmlDocument(title: string, body: string): string {
  return [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"><title>" + escapeHtml(title) + "</title>",
    "<style>",
    "@page { size: A4; margin: 22mm 20mm 22mm 20mm; }",
    "body { color:#111827; font-family:\"Microsoft YaHei\",\"Noto Sans CJK SC\",Arial,sans-serif; font-size:11pt; line-height:1.65; }",
    "h1 { font-size:24pt; margin:0 0 18pt; color:#111827; }",
    "h2 { font-size:17pt; margin:20pt 0 9pt; color:#111827; }",
    "h3 { font-size:13pt; margin:15pt 0 6pt; color:#111827; }",
    "p { margin:0 0 8pt; } ul,ol { margin:4pt 0 10pt 18pt; }",
    "blockquote { margin:10pt 0; padding-left:12pt; border-left:3pt solid #94a3b8; color:#475569; }",
    "code,pre { font-family:Consolas,monospace; background:#f1f5f9; } pre { padding:10pt; white-space:pre-wrap; }",
    "table { border-collapse:collapse; width:100%; margin:10pt 0; }",
    "th,td { border:1pt solid #d1d5db; padding:5pt; vertical-align:top; } th { background:#e2e8f0; }",
    "img { max-width:100%; height:auto; }",
    "</style></head><body>",
    body,
    "</body></html>",
  ].join("\n");
}

async function buildMarkdownHtml(
  sourcePath: string,
  templatePath: string | undefined,
  values: Record<string, string>,
  cwd: string,
): Promise<{ html: string; wordTemplatePath?: string }> {
  const sourceMarkdown = await readFile(sourcePath, "utf-8");
  const title = values.title || path.basename(sourcePath, path.extname(sourcePath));
  if (templatePath && [".docx", ".dotx"].includes(extensionOf(templatePath))) {
    const parsed = marked.parse(sourceMarkdown, { async: false, gfm: true }) as string;
    const body = normalizeImageSources(sanitizeHtml(parsed), path.dirname(sourcePath), cwd);
    return { html: defaultHtmlDocument(title, body), wordTemplatePath: templatePath };
  }
  let markdown = sourceMarkdown;
  if (templatePath && [".md", ".markdown"].includes(extensionOf(templatePath))) {
    const template = await readFile(templatePath, "utf-8");
    markdown = replaceTemplateTokens(template, { ...values, content: sourceMarkdown }, sourceMarkdown);
  }
  const parsed = marked.parse(markdown, { async: false, gfm: true }) as string;
  const contentHtml = normalizeImageSources(sanitizeHtml(parsed), path.dirname(sourcePath), cwd);
  if (templatePath && [".html", ".htm"].includes(extensionOf(templatePath))) {
    const template = await readFile(templatePath, "utf-8");
    const htmlValues: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) htmlValues[key] = escapeHtml(value);
    htmlValues.content = contentHtml;
    const filled = replaceTemplateTokens(template, htmlValues, contentHtml);
    return {
      html: normalizeImageSources(sanitizeHtml(filled), path.dirname(templatePath), cwd),
    };
  }
  return { html: defaultHtmlDocument(title, contentHtml) };
}

async function findPython(cwd: string, timeoutMs: number): Promise<PythonCommand> {
  const configured = process.env.CCAGENT_PYTHON?.trim();
  const candidates: PythonCommand[] = configured
    ? [{ executable: configured, prefixArgs: [] }]
    : process.platform === "win32"
      ? [
          { executable: "python", prefixArgs: [] },
          { executable: "py", prefixArgs: ["-3"] },
          { executable: "python3", prefixArgs: [] },
        ]
      : [
          { executable: "python3", prefixArgs: [] },
          { executable: "python", prefixArgs: [] },
        ];
  for (const candidate of candidates) {
    try {
      await runProcess(candidate.executable, [...candidate.prefixArgs, "--version"], {
        cwd,
        timeoutMs: Math.min(timeoutMs, 8_000),
      });
      return candidate;
    } catch {
      // Try the next interpreter.
    }
  }
  throw new ConversionError(
    "Python 3 was not found.",
    "Install Python 3 or set CCAGENT_PYTHON to its executable path.",
  );
}

async function runPythonScript(
  script: string,
  args: string[],
  context: ToolContext,
  timeoutMs: number,
): Promise<ProcessOutput> {
  const python = await findPython(context.cwd, timeoutMs);
  return await withTempDir("ccagent-doc-python-", async (dir) => {
    const scriptPath = path.join(dir, "convert.py");
    await writeFile(scriptPath, script, "utf-8");
    return await runProcess(python.executable, [...python.prefixArgs, scriptPath, ...args], {
      cwd: context.cwd,
      timeoutMs,
      signal: context.abortSignal,
      env: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
  });
}

const PDF_TO_DOCX_SCRIPT = [
  "import os",
  "import sys",
  "source, output = sys.argv[1], sys.argv[2]",
  "try:",
  "    from pdf2docx import Converter",
  "except Exception as exc:",
  "    sys.stderr.write('Missing Python package pdf2docx. Install with: python -m pip install pdf2docx\\n' + str(exc))",
  "    raise SystemExit(3)",
  "converter = Converter(source)",
  "try:",
  "    converter.convert(output, start=0, end=None)",
  "finally:",
  "    converter.close()",
  "if not os.path.isfile(output) or os.path.getsize(output) == 0:",
  "    raise RuntimeError('pdf2docx did not create a non-empty DOCX')",
  "print('pdf2docx')",
].join("\n");

const PDF_TO_MARKDOWN_SCRIPT = [
  "import re",
  "import statistics",
  "import sys",
  "source, output = sys.argv[1], sys.argv[2]",
  "def clean_line(text):",
  "    return re.sub(r'\\s+', ' ', text or '').strip()",
  "def with_page_markers(pages):",
  "    blocks = []",
  "    for index, page in enumerate(pages, 1):",
  "        text = page.strip()",
  "        if text:",
  "            blocks.append('<!-- Page %d -->\\n\\n%s' % (index, text))",
  "    return '\\n\\n'.join(blocks).strip() + '\\n'",
  "def extract_with_fitz():",
  "    import fitz",
  "    document = fitz.open(source)",
  "    pages = []",
  "    for page in document:",
  "        data = page.get_text('dict')",
  "        sizes = []",
  "        raw_lines = []",
  "        for block in data.get('blocks', []):",
  "            if block.get('type') != 0:",
  "                continue",
  "            for line in block.get('lines', []):",
  "                spans = line.get('spans', [])",
  "                text = clean_line(''.join(span.get('text', '') for span in spans))",
  "                if not text:",
  "                    continue",
  "                size = max([float(span.get('size', 0)) for span in spans] or [0])",
  "                sizes.extend(float(span.get('size', 0)) for span in spans if span.get('text', '').strip())",
  "                raw_lines.append((text, size))",
  "        body = statistics.median(sizes) if sizes else 10.0",
  "        lines = []",
  "        for text, size in raw_lines:",
  "            if size >= body * 1.65 and len(text) < 100:",
  "                lines.append('# ' + text)",
  "            elif size >= body * 1.35 and len(text) < 120:",
  "                lines.append('## ' + text)",
  "            elif size >= body * 1.15 and len(text) < 140:",
  "                lines.append('### ' + text)",
  "            elif re.match(r'^[*+-]\\s+', text):",
  "                lines.append('- ' + re.sub(r'^[*+-]\\s+', '', text))",
  "            else:",
  "                lines.append(text)",
  "        pages.append('\\n\\n'.join(lines))",
  "    document.close()",
  "    return pages, 'PyMuPDF'",
  "def extract_with_pdfplumber():",
  "    import pdfplumber",
  "    pages = []",
  "    with pdfplumber.open(source) as document:",
  "        for page in document.pages:",
  "            text = page.extract_text(layout=True) or ''",
  "            lines = [clean_line(line) for line in text.splitlines()]",
  "            pages.append('\\n\\n'.join(line for line in lines if line))",
  "    return pages, 'pdfplumber'",
  "errors = []",
  "for extractor in (extract_with_fitz, extract_with_pdfplumber):",
  "    try:",
  "        pages, engine = extractor()",
  "        break",
  "    except Exception as exc:",
  "        errors.append(str(exc))",
  "else:",
  "    sys.stderr.write('PDF text extraction requires PyMuPDF or pdfplumber. Install with: python -m pip install pymupdf pdfplumber\\n' + '\\n'.join(errors))",
  "    raise SystemExit(3)",
  "markdown = with_page_markers(pages)",
  "if not markdown.strip():",
  "    sys.stderr.write('No extractable text was found. The PDF may be scanned and require OCR.')",
  "    raise SystemExit(4)",
  "with open(output, 'w', encoding='utf-8', newline='\\n') as stream:",
  "    stream.write(markdown)",
  "print(engine)",
].join("\n");

function powershellPreamble(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$word = $null",
    "$sourceDoc = $null",
    "$targetDoc = $null",
  ].join("\n");
}

function powershellCleanup(): string {
  return [
    "if ($sourceDoc -ne $null) { try { $sourceDoc.Close(0) } catch {} }",
    "if ($targetDoc -ne $null) { try { $targetDoc.Close(0) } catch {} }",
    "if ($word -ne $null) { try { $word.Quit() } catch {} }",
    "if ($sourceDoc -ne $null) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($sourceDoc) }",
    "if ($targetDoc -ne $null) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($targetDoc) }",
    "if ($word -ne $null) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) }",
    "[GC]::Collect()",
    "[GC]::WaitForPendingFinalizers()",
  ].join("\n");
}

async function runPowerShell(
  script: string,
  env: NodeJS.ProcessEnv,
  context: ToolContext,
  timeoutMs: number,
): Promise<ProcessOutput> {
  if (process.platform !== "win32") {
    throw new ConversionError("Microsoft Word automation is only available on Windows.");
  }
  const executable = process.env.CCAGENT_POWERSHELL?.trim() || "powershell.exe";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return await runProcess(
    executable,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { cwd: context.cwd, timeoutMs, signal: context.abortSignal, env },
  );
}

async function convertWithMicrosoftWord(
  sourcePath: string,
  outputPath: string,
  target: "pdf" | "docx",
  context: ToolContext,
  timeoutMs: number,
): Promise<void> {
  const script = [
    powershellPreamble(),
    "try {",
    "  $word = New-Object -ComObject Word.Application",
    "  $word.Visible = $false",
    "  $word.DisplayAlerts = 0",
    "  $sourceDoc = $word.Documents.Open($env:CC_SOURCE, $false, $true)",
    "  $format = if ($env:CC_TARGET -eq 'pdf') { 17 } else { 16 }",
    "  $sourceDoc.SaveAs2($env:CC_OUTPUT, $format)",
    "  if (-not (Test-Path -LiteralPath $env:CC_OUTPUT)) { throw 'Microsoft Word produced no output file.' }",
    "  Write-Output 'Microsoft Word COM'",
    "} finally {",
    powershellCleanup(),
    "}",
  ].join("\n");
  await runPowerShell(
    script,
    { CC_SOURCE: sourcePath, CC_OUTPUT: outputPath, CC_TARGET: target },
    context,
    timeoutMs,
  );
}

async function mergeWithMicrosoftWord(
  templatePath: string,
  contentDocumentPath: string,
  outputPath: string,
  values: Record<string, string>,
  context: ToolContext,
  timeoutMs: number,
): Promise<void> {
  const script = [
    powershellPreamble(),
    "function Replace-AllStories($document, $needle, $replacement) {",
    "  for ($storyType = 1; $storyType -le 17; $storyType++) {",
    "    try {",
    "      $range = $document.StoryRanges.Item($storyType)",
    "      while ($range -ne $null) {",
    "        $find = $range.Find",
    "        $find.ClearFormatting()",
    "        $find.Replacement.ClearFormatting()",
    "        [void]$find.Execute($needle, $false, $false, $false, $false, $false, $true, 1, $false, $replacement, 2)",
    "        $range = $range.NextStoryRange",
    "      }",
    "    } catch {}",
    "  }",
    "}",
    "try {",
    "  $word = New-Object -ComObject Word.Application",
    "  $word.Visible = $false",
    "  $word.DisplayAlerts = 0",
    "  $sourceDoc = $word.Documents.Open($env:CC_SOURCE, $false, $true)",
    "  if ([IO.Path]::GetExtension($env:CC_TEMPLATE).ToLowerInvariant() -eq '.dotx') {",
    "    $targetDoc = $word.Documents.Add($env:CC_TEMPLATE)",
    "  } else {",
    "    $targetDoc = $word.Documents.Open($env:CC_TEMPLATE, $false, $false)",
    "  }",
    "  $payload = ConvertFrom-Json $env:CC_TEMPLATE_DATA",
    "  foreach ($property in $payload.PSObject.Properties) {",
    "    Replace-AllStories $targetDoc ('{{' + $property.Name + '}}') ([string]$property.Value)",
    "  }",
    "  $slot = $targetDoc.Content.Duplicate",
    "  $slot.Find.ClearFormatting()",
    "  $found = $slot.Find.Execute('{{content}}')",
    "  $sourceRange = $sourceDoc.Content.Duplicate",
    "  if ($sourceRange.End -gt $sourceRange.Start) { $sourceRange.End = $sourceRange.End - 1 }",
    "  if ($found) {",
    "    $slot.FormattedText = $sourceRange.FormattedText",
    "  } else {",
    "    $append = $targetDoc.Range($targetDoc.Content.End - 1, $targetDoc.Content.End - 1)",
    "    $append.InsertParagraphBefore()",
    "    $append.FormattedText = $sourceRange.FormattedText",
    "  }",
    "  $targetDoc.SaveAs2($env:CC_OUTPUT, 16)",
    "  if (-not (Test-Path -LiteralPath $env:CC_OUTPUT)) { throw 'Microsoft Word produced no merged document.' }",
    "  Write-Output 'Microsoft Word template merge'",
    "} finally {",
    powershellCleanup(),
    "}",
  ].join("\n");
  await runPowerShell(
    script,
    {
      CC_SOURCE: contentDocumentPath,
      CC_TEMPLATE: templatePath,
      CC_OUTPUT: outputPath,
      CC_TEMPLATE_DATA: JSON.stringify(values),
    },
    context,
    timeoutMs,
  );
}

async function findLibreOffice(cwd: string, timeoutMs: number): Promise<string | null> {
  const configured = process.env.CCAGENT_LIBREOFFICE?.trim();
  const candidates = [
    ...(configured ? [configured] : []),
    ...(process.platform === "win32"
      ? [
          "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
          "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
          "soffice.exe",
        ]
      : process.platform === "darwin"
        ? ["/Applications/LibreOffice.app/Contents/MacOS/soffice", "soffice", "libreoffice"]
        : ["soffice", "libreoffice"]),
  ];
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    try {
      await runProcess(candidate, ["--version"], {
        cwd,
        timeoutMs: Math.min(timeoutMs, 8_000),
      });
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function convertWithLibreOffice(
  sourcePath: string,
  outputPath: string,
  context: ToolContext,
  timeoutMs: number,
): Promise<void> {
  const executable = await findLibreOffice(context.cwd, timeoutMs);
  if (!executable) {
    throw new ConversionError(
      "LibreOffice was not found.",
      "Install LibreOffice or set CCAGENT_LIBREOFFICE to the soffice executable.",
    );
  }
  await withTempDir("ccagent-libreoffice-", async (dir) => {
    const profileDir = path.join(dir, "profile");
    const outputDir = path.join(dir, "output");
    await mkdir(profileDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await runProcess(
      executable,
      [
        "--headless",
        "-env:UserInstallation=" + pathToFileURL(profileDir).href,
        "--convert-to",
        "pdf",
        "--outdir",
        outputDir,
        sourcePath,
      ],
      { cwd: context.cwd, timeoutMs, signal: context.abortSignal },
    );
    const converted = path.join(
      outputDir,
      path.basename(sourcePath, path.extname(sourcePath)) + ".pdf",
    );
    await copyFile(converted, outputPath);
  });
}

async function convertOfficeToPdf(
  sourcePath: string,
  outputPath: string,
  context: ToolContext,
  timeoutMs: number,
): Promise<string> {
  const failures: string[] = [];
  const preferred = process.env.CCAGENT_OFFICE_ENGINE?.trim().toLowerCase();
  const tryWord = preferred !== "libreoffice" && process.platform === "win32";
  if (tryWord) {
    try {
      await convertWithMicrosoftWord(sourcePath, outputPath, "pdf", context, timeoutMs);
      return "Microsoft Word";
    } catch (error: unknown) {
      failures.push("Microsoft Word: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  try {
    await convertWithLibreOffice(sourcePath, outputPath, context, timeoutMs);
    return "LibreOffice";
  } catch (error: unknown) {
    failures.push("LibreOffice: " + (error instanceof Error ? error.message : String(error)));
  }
  if (!tryWord && process.platform === "win32") {
    try {
      await convertWithMicrosoftWord(sourcePath, outputPath, "pdf", context, timeoutMs);
      return "Microsoft Word";
    } catch (error: unknown) {
      failures.push("Microsoft Word: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  throw new ConversionError(
    "No Word/PDF rendering engine succeeded.\n" + failures.join("\n"),
    "Install Microsoft Word (Windows) or LibreOffice, or configure CCAGENT_LIBREOFFICE.",
  );
}

async function convertPdfToDocx(
  sourcePath: string,
  outputPath: string,
  context: ToolContext,
  timeoutMs: number,
): Promise<string> {
  const failures: string[] = [];
  try {
    const result = await runPythonScript(
      PDF_TO_DOCX_SCRIPT,
      [sourcePath, outputPath],
      context,
      timeoutMs,
    );
    return result.stdout || "pdf2docx";
  } catch (error: unknown) {
    failures.push("pdf2docx: " + (error instanceof Error ? error.message : String(error)));
  }
  if (process.platform === "win32") {
    try {
      await convertWithMicrosoftWord(sourcePath, outputPath, "docx", context, timeoutMs);
      return "Microsoft Word PDF reflow";
    } catch (error: unknown) {
      failures.push("Microsoft Word: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  throw new ConversionError(
    "No PDF-to-Word engine succeeded.\n" + failures.join("\n"),
    "Install Python 3 with pdf2docx or Microsoft Word on Windows.",
  );
}

async function extractPdfMarkdown(
  sourcePath: string,
  outputPath: string,
  context: ToolContext,
  timeoutMs: number,
): Promise<string> {
  const result = await runPythonScript(
    PDF_TO_MARKDOWN_SCRIPT,
    [sourcePath, outputPath],
    context,
    timeoutMs,
  );
  return result.stdout || "PDF text extractor";
}

async function validateOutput(filePath: string, kind: DocumentConversionKind): Promise<number> {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile() || info.size === 0) {
    throw new ConversionError("Converter did not create a non-empty output file.");
  }
  const bytes = await readFile(filePath);
  if (
    (kind === "markdown-to-pdf" || kind === "word-to-pdf") &&
    bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
  ) {
    throw new ConversionError("Output validation failed: file does not have a PDF signature.");
  }
  if (kind === "pdf-to-word" && bytes.subarray(0, 2).toString("ascii") !== "PK") {
    throw new ConversionError("Output validation failed: file does not have a DOCX/ZIP signature.");
  }
  if (kind === "pdf-to-markdown" && !bytes.toString("utf-8").trim()) {
    throw new ConversionError("Output validation failed: Markdown is empty.");
  }
  return info.size;
}

async function commitOutput(
  stagedPath: string,
  outputPath: string,
  overwrite: boolean,
): Promise<void> {
  if (!overwrite) {
    try {
      await link(stagedPath, outputPath);
      await rm(stagedPath, { force: true });
      return;
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "EEXIST") {
        throw new ConversionError(
          "Output was created by another process before conversion finished: " + outputPath,
          "Choose another output_path or set overwrite=true.",
        );
      }
      if (err.code !== "EXDEV" && err.code !== "EPERM" && err.code !== "ENOTSUP") throw error;
    }
    await copyFile(stagedPath, outputPath, fsConstants.COPYFILE_EXCL).catch((error: unknown) => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "EEXIST") {
        throw new ConversionError(
          "Output was created by another process before conversion finished: " + outputPath,
          "Choose another output_path or set overwrite=true.",
        );
      }
      throw error;
    });
    await rm(stagedPath, { force: true });
    return;
  }

  const backupPath = outputPath + ".ccagent-backup-" + randomUUID();
  let hasBackup = false;
  try {
    try {
      await rename(outputPath, backupPath);
      hasBackup = true;
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw error;
    }
    await rename(stagedPath, outputPath);
  } catch (error: unknown) {
    if (hasBackup) {
      try {
        await rm(outputPath, { force: true });
        await rename(backupPath, outputPath);
      } catch (restoreError: unknown) {
        throw new ConversionError(
          "Failed to commit the converted output and could not automatically restore the previous file. " +
            "The backup is retained at: " +
            backupPath,
          "Restore the backup manually. Commit error: " +
            (error instanceof Error ? error.message : String(error)) +
            "; restore error: " +
            (restoreError instanceof Error ? restoreError.message : String(restoreError)),
        );
      }
    }
    throw error;
  }
  if (hasBackup) await rm(backupPath, { force: true }).catch(() => {});
}

function makeTemplateValues(
  sourcePath: string,
  title: string | undefined,
  templateData: Record<string, string>,
): Record<string, string> {
  return {
    ...templateData,
    title:
      typeof title === "string" && title.trim()
        ? title.trim()
        : path.basename(sourcePath, path.extname(sourcePath)),
    source: path.basename(sourcePath),
    date: new Date().toISOString().slice(0, 10),
  };
}

export function formatConversionError(error: unknown): string {
  if (error instanceof ConversionError) {
    return "Error: " + error.message + (error.recovery ? "\nRecovery: " + error.recovery : "");
  }
  return "Error: " + (error instanceof Error ? error.message : String(error));
}

export async function convertDocument(
  kind: DocumentConversionKind,
  input: DocumentConversionInput,
  context: ToolContext,
): Promise<DocumentConversionOutcome> {
  const canonicalCwd = await realpath(context.cwd).catch(() => path.resolve(context.cwd));
  context = { ...context, cwd: canonicalCwd };
  const timeoutMs = normalizeTimeout(input.timeout_ms);
  const overwrite = input.overwrite === true;
  const sourcePath = await resolveInputFile(
    input.source_path,
    context.cwd,
    SOURCE_EXTENSIONS[kind],
    "source_path",
    kind === "markdown-to-pdf" ? MAX_MARKDOWN_BYTES : MAX_DOCUMENT_BYTES,
  );
  const outputPath = await resolveOutputFile(
    input.output_path,
    context.cwd,
    OUTPUT_EXTENSIONS[kind],
    overwrite,
  );
  const templatePath = input.template_path
    ? await resolveInputFile(
        input.template_path,
        context.cwd,
        TEMPLATE_EXTENSIONS[kind],
        "template_path",
      )
    : undefined;
  if (
    path.resolve(sourcePath) === path.resolve(outputPath) ||
    (await sameExistingFile(sourcePath, outputPath))
  ) {
    throw new ConversionError("source_path and output_path must be different.");
  }
  if (
    templatePath &&
    (path.resolve(templatePath) === path.resolve(outputPath) ||
      (await sameExistingFile(templatePath, outputPath)))
  ) {
    throw new ConversionError("template_path and output_path must be different.");
  }

  const values = makeTemplateValues(
    sourcePath,
    input.title,
    normalizeTemplateData(input.template_data),
  );
  const outputExt = path.extname(outputPath);
  const stagedPath = path.join(
    path.dirname(outputPath),
    "." +
      path.basename(outputPath, outputExt) +
      "." +
      randomUUID() +
      ".tmp" +
      outputExt,
  );
  let engine = "";
  try {
    if (kind === "markdown-to-pdf") {
      const built = await buildMarkdownHtml(sourcePath, templatePath, values, context.cwd);
      engine = await withTempDir("ccagent-markdown-pdf-", async (dir) => {
        const htmlPath = path.join(dir, "content.html");
        await writeFile(htmlPath, built.html, "utf-8");
        if (built.wordTemplatePath) {
          const mergedPath = path.join(dir, "templated.docx");
          await mergeWithMicrosoftWord(
            built.wordTemplatePath,
            htmlPath,
            mergedPath,
            values,
            context,
            timeoutMs,
          );
          const renderer = await convertOfficeToPdf(
            mergedPath,
            stagedPath,
            context,
            timeoutMs,
          );
          return "Microsoft Word template merge + " + renderer;
        }
        return await convertOfficeToPdf(htmlPath, stagedPath, context, timeoutMs);
      });
    } else if (kind === "word-to-pdf") {
      if (templatePath) {
        engine = await withTempDir("ccagent-word-template-", async (dir) => {
          const mergedPath = path.join(dir, "templated.docx");
          await mergeWithMicrosoftWord(
            templatePath,
            sourcePath,
            mergedPath,
            values,
            context,
            timeoutMs,
          );
          const renderer = await convertOfficeToPdf(
            mergedPath,
            stagedPath,
            context,
            timeoutMs,
          );
          return "Microsoft Word template merge + " + renderer;
        });
      } else {
        engine = await convertOfficeToPdf(sourcePath, stagedPath, context, timeoutMs);
      }
    } else if (kind === "pdf-to-word") {
      if (templatePath) {
        engine = await withTempDir("ccagent-pdf-word-", async (dir) => {
          const convertedPath = path.join(dir, "converted.docx");
          const converter = await convertPdfToDocx(
            sourcePath,
            convertedPath,
            context,
            timeoutMs,
          );
          await mergeWithMicrosoftWord(
            templatePath,
            convertedPath,
            stagedPath,
            values,
            context,
            timeoutMs,
          );
          return converter + " + Microsoft Word template merge";
        });
      } else {
        engine = await convertPdfToDocx(sourcePath, stagedPath, context, timeoutMs);
      }
    } else {
      engine = await withTempDir("ccagent-pdf-markdown-", async (dir) => {
        const extractedPath = path.join(dir, "extracted.md");
        const extractor = await extractPdfMarkdown(
          sourcePath,
          extractedPath,
          context,
          timeoutMs,
        );
        const content = await readFile(extractedPath, "utf-8");
        const rendered = templatePath
          ? replaceTemplateTokens(
              await readFile(templatePath, "utf-8"),
              { ...values, content },
              content,
            )
          : content;
        await writeFile(stagedPath, rendered, "utf-8");
        return extractor;
      });
    }

    const bytes = await validateOutput(stagedPath, kind);
    await commitOutput(stagedPath, outputPath, overwrite);
    return {
      sourcePath,
      outputPath,
      ...(templatePath ? { templatePath } : {}),
      engine,
      bytes,
    };
  } catch (error: unknown) {
    await rm(stagedPath, { force: true }).catch(() => {});
    if (error instanceof ConversionError) throw error;
    throw new ConversionError(error instanceof Error ? error.message : String(error));
  }
}
