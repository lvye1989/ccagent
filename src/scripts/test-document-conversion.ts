#!/usr/bin/env tsx

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { getAllTools } from "../tools/index.js";
import { toolResultText } from "../tools/Tool.js";
import {
  DOCUMENT_CONVERSION_TOOL_NAMES,
  markdownToPdfTool,
  pdfToMarkdownTool,
  pdfToWordTool,
  wordToPdfTool,
} from "../tools/documentConversionTools.js";

const failures: string[] = [];

function assert(condition: unknown, label: string): void {
  const marker = condition ? "PASS" : "FAIL";
  console.log("  [" + marker + "] " + label);
  if (!condition) failures.push(label);
}

async function exists(filePath: string): Promise<boolean> {
  return await fs.access(filePath).then(() => true).catch(() => false);
}

async function signature(filePath: string, length: number): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return buffer.toString("ascii");
  } finally {
    await handle.close();
  }
}

function createDocxTemplate(templatePath: string): boolean {
  const script = [
    "from docx import Document",
    "import sys",
    "document = Document()",
    "document.add_heading('{{title}}', 0)",
    "document.add_paragraph('Client: {{client}}')",
    "document.add_paragraph('{{content}}')",
    "document.save(sys.argv[1])",
  ].join("\n");
  const result = spawnSync("python", ["-c", script, templatePath], {
    encoding: "utf-8",
    windowsHide: true,
  });
  if (result.status !== 0) console.log("  Python template setup skipped: " + result.stderr.trim());
  return result.status === 0;
}

function readDocxText(docxPath: string): string {
  const script = [
    "from docx import Document",
    "import sys",
    "document = Document(sys.argv[1])",
    "print('\\n'.join(paragraph.text for paragraph in document.paragraphs))",
  ].join("\n");
  const result = spawnSync("python", ["-c", script, docxPath], {
    encoding: "utf-8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout : "";
}

async function main(): Promise<void> {
  console.log("\n[1] Registry and validation");
  const registered = new Set(getAllTools().map((tool) => tool.name));
  for (const name of DOCUMENT_CONVERSION_TOOL_NAMES) {
    assert(registered.has(name), name + " is registered");
  }
  assert(
    [markdownToPdfTool, wordToPdfTool, pdfToWordTool, pdfToMarkdownTool].every(
      (tool) => !tool.isReadOnly() && tool.isEnabled(),
    ),
    "all conversion tools are enabled file-writing tools",
  );

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-doc-tools-"));
  const keep = process.env.KEEP_DOCUMENT_TEST_OUTPUT === "1";
  try {
    const sourcePath = path.join(dir, "source.md");
    await fs.writeFile(sourcePath, "# Conversion Probe 731\n\nA conversion test paragraph.\n", "utf-8");
    const invalid = await markdownToPdfTool.call(
      { source_path: sourcePath, output_path: path.join(dir, "wrong.docx") },
      { cwd: dir },
    );
    assert(invalid.isError === true, "invalid output extension is rejected before conversion");

    const outsidePath = path.join(path.dirname(dir), "outside-source.md");
    await fs.writeFile(outsidePath, "outside", "utf-8");
    try {
      const outside = await markdownToPdfTool.call(
        { source_path: outsidePath, output_path: path.join(dir, "outside.pdf") },
        { cwd: dir },
      );
      assert(outside.isError === true, "source outside the workspace is rejected");
    } finally {
      await fs.rm(outsidePath, { force: true });
    }

    const reservedPath = path.join(dir, "reserved.pdf");
    await fs.writeFile(reservedPath, "keep-me", "utf-8");
    const collision = await markdownToPdfTool.call(
      { source_path: sourcePath, output_path: reservedPath },
      { cwd: dir },
    );
    assert(collision.isError === true, "existing output requires overwrite=true");
    assert((await fs.readFile(reservedPath, "utf-8")) === "keep-me", "collision preserves existing output");

    const directoryOutput = path.join(dir, "directory.pdf");
    await fs.mkdir(directoryOutput);
    const directoryCollision = await markdownToPdfTool.call(
      { source_path: sourcePath, output_path: directoryOutput, overwrite: true },
      { cwd: dir },
    );
    assert(directoryCollision.isError === true, "overwrite never replaces a directory");
    assert((await fs.stat(directoryOutput)).isDirectory(), "directory collision remains intact");

    if (process.env.LIVE_DOCUMENT_CONVERSION !== "1") {
      console.log("\n[2] Live conversion skipped (set LIVE_DOCUMENT_CONVERSION=1)");
      if (failures.length > 0) process.exitCode = 1;
      return;
    }

    console.log("\n[2] Live Markdown/PDF/Word conversion chain");
    const markdownTemplate = path.join(dir, "template.md");
    await fs.writeFile(
      markdownTemplate,
      "# {{title}}\n\nClient: {{client}}\n\n{{content}}\n\nSource: {{source}}\n",
      "utf-8",
    );
    const pdfPath = path.join(dir, "from-markdown.pdf");
    const markdownPdf = await markdownToPdfTool.call(
      {
        source_path: sourcePath,
        output_path: pdfPath,
        template_path: markdownTemplate,
        template_data: { client: "CCAGENT" },
        title: "Template Conversion",
      },
      { cwd: dir },
    );
    if (markdownPdf.isError) console.log(toolResultText(markdownPdf.content));
    assert(!markdownPdf.isError && (await signature(pdfPath, 5)) === "%PDF-", "Markdown + template converts to a valid PDF");

    const overwritePdf = await markdownToPdfTool.call(
      {
        source_path: sourcePath,
        output_path: pdfPath,
        template_path: markdownTemplate,
        template_data: { client: "CCAGENT" },
        title: "Template Conversion",
        overwrite: true,
      },
      { cwd: dir },
    );
    const backupFiles = (await fs.readdir(dir)).filter((name) => name.includes(".ccagent-backup-"));
    assert(
      !overwritePdf.isError &&
        (await signature(pdfPath, 5)) === "%PDF-" &&
        backupFiles.length === 0,
      "overwrite replaces the output atomically and removes its temporary backup",
    );

    const extractedTemplate = path.join(dir, "markdown-output-template.md");
    await fs.writeFile(extractedTemplate, "# {{title}}\n\n{{content}}\n\nOwner: {{owner}}\n", "utf-8");
    const extractedPath = path.join(dir, "from-pdf.md");
    const pdfMarkdown = await pdfToMarkdownTool.call(
      {
        source_path: pdfPath,
        output_path: extractedPath,
        template_path: extractedTemplate,
        template_data: { owner: "CCAGENT" },
        title: "Extracted Document",
      },
      { cwd: dir },
    );
    if (pdfMarkdown.isError) console.log(toolResultText(pdfMarkdown.content));
    const extracted = (await exists(extractedPath)) ? await fs.readFile(extractedPath, "utf-8") : "";
    assert(
      !pdfMarkdown.isError &&
        extracted.includes("Extracted Document") &&
        extracted.includes("Conversion Probe 731") &&
        extracted.includes("Owner: CCAGENT"),
      "PDF to Markdown preserves extracted content and template placeholders",
    );

    const docxPath = path.join(dir, "from-pdf.docx");
    const pdfWord = await pdfToWordTool.call(
      { source_path: pdfPath, output_path: docxPath },
      { cwd: dir },
    );
    if (pdfWord.isError) console.log(toolResultText(pdfWord.content));
    assert(!pdfWord.isError && (await signature(docxPath, 2)) === "PK", "PDF converts to a valid DOCX");

    const roundtripPdf = path.join(dir, "word-roundtrip.pdf");
    const wordPdf = await wordToPdfTool.call(
      { source_path: docxPath, output_path: roundtripPdf },
      { cwd: dir },
    );
    if (wordPdf.isError) console.log(toolResultText(wordPdf.content));
    assert(!wordPdf.isError && (await signature(roundtripPdf, 5)) === "%PDF-", "converted DOCX converts back to a valid PDF");

    console.log("\n[3] Live DOCX template merge");
    const docxTemplate = path.join(dir, "template.docx");
    if (createDocxTemplate(docxTemplate)) {
      const templatedDocx = path.join(dir, "templated.docx");
      const templated = await pdfToWordTool.call(
        {
          source_path: pdfPath,
          output_path: templatedDocx,
          template_path: docxTemplate,
          template_data: { client: "Template Client" },
          title: "DOCX Template Title",
        },
        { cwd: dir },
      );
      if (templated.isError) console.log(toolResultText(templated.content));
      const text = (await exists(templatedDocx)) ? readDocxText(templatedDocx) : "";
      assert(
        !templated.isError &&
          text.includes("DOCX Template Title") &&
          text.includes("Client: Template Client") &&
          text.includes("Conversion Probe 731"),
        "uploaded DOCX template receives scalar placeholders and source content",
      );
    } else {
      assert(false, "python-docx is available for the live DOCX template test");
    }

    console.log(keep ? "\nLive output retained: " + dir : "\nLive output verified and removed.");
  } finally {
    if (!keep) await fs.rm(dir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error("\nDocument conversion checks failed: " + failures.join(", "));
    process.exitCode = 1;
  } else {
    console.log("\nAll document conversion checks passed.");
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
