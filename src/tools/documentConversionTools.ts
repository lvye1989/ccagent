import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import {
  convertDocument,
  formatConversionError,
  type DocumentConversionInput,
  type DocumentConversionKind,
} from "./documentConversionRuntime.js";

export const DOCUMENT_CONVERSION_TOOL_NAMES = [
  "MarkdownToPdf",
  "WordToPdf",
  "PdfToWord",
  "PdfToMarkdown",
] as const;

const sharedProperties = {
  source_path: {
    type: "string" as const,
    description: "Source file path, absolute or relative to the current workspace.",
  },
  output_path: {
    type: "string" as const,
    description: "Destination file path, absolute or relative to the current workspace.",
  },
  template_path: {
    type: "string" as const,
    description:
      "Optional uploaded template file. Use {{content}}, {{title}}, {{source}}, {{date}}, or keys from template_data as placeholders.",
  },
  template_data: {
    type: "object" as const,
    additionalProperties: true,
    description: "Optional scalar values for custom {{placeholder}} tokens in the template.",
  },
  title: {
    type: "string" as const,
    description: "Optional document title; defaults to the source filename.",
  },
  overwrite: {
    type: "boolean" as const,
    description: "Replace output_path when it already exists. Defaults to false.",
  },
  timeout_ms: {
    type: "integer" as const,
    minimum: 1000,
    maximum: 600000,
    description: "Converter timeout in milliseconds. Defaults to 180000.",
  },
};

function formatSuccess(label: string, result: Awaited<ReturnType<typeof convertDocument>>): string {
  const lines = [
    label + " completed.",
    "Source: " + result.sourcePath,
    "Output: " + result.outputPath,
    "Engine: " + result.engine,
    "Bytes: " + result.bytes,
  ];
  if (result.templatePath) lines.splice(3, 0, "Template: " + result.templatePath);
  return lines.join("\n");
}

function createConversionTool(options: {
  name: (typeof DOCUMENT_CONVERSION_TOOL_NAMES)[number];
  kind: DocumentConversionKind;
  label: string;
  description: string;
}): Tool {
  return {
    name: options.name,
    description: options.description,
    inputSchema: {
      type: "object" as const,
      properties: sharedProperties,
      required: ["source_path", "output_path"],
    },
    async call(rawInput: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      try {
        const result = await convertDocument(
          options.kind,
          rawInput as unknown as DocumentConversionInput,
          context,
        );
        return { content: formatSuccess(options.label, result) };
      } catch (error: unknown) {
        return { content: formatConversionError(error), isError: true };
      }
    },
    isReadOnly(): boolean {
      return false;
    },
    isEnabled(): boolean {
      return true;
    },
  };
}

export const markdownToPdfTool = createConversionTool({
  name: "MarkdownToPdf",
  kind: "markdown-to-pdf",
  label: "Markdown to PDF conversion",
  description:
    "Convert a Markdown (sometimes called markon) file to PDF. Supports Markdown, HTML, DOCX, or DOTX templates and placeholder data. Use for creating a PDF from an uploaded Markdown source/template.",
});

export const wordToPdfTool = createConversionTool({
  name: "WordToPdf",
  kind: "word-to-pdf",
  label: "Word to PDF conversion",
  description:
    "Convert DOC, DOCX, DOCM, RTF, or ODT to PDF. An optional DOCX/DOTX template can wrap the source content through {{content}} and other placeholders.",
});

export const pdfToWordTool = createConversionTool({
  name: "PdfToWord",
  kind: "pdf-to-word",
  label: "PDF to Word conversion",
  description:
    "Convert a text-based PDF to editable DOCX. Supports an optional uploaded DOCX/DOTX template with placeholders; complex PDF layouts may require manual cleanup.",
});

export const pdfToMarkdownTool = createConversionTool({
  name: "PdfToMarkdown",
  kind: "pdf-to-markdown",
  label: "PDF to Markdown conversion",
  description:
    "Extract a text-based PDF into Markdown with page markers and heading heuristics. Supports an optional Markdown/text template with placeholders; scanned PDFs require OCR first.",
});
