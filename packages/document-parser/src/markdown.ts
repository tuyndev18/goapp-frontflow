import type { SourceReference } from "@frontflow/domain";
import { excerpt, stripInline } from "./text.js";

export interface MdLine {
  text: string;
  line: number;
}

export interface MdHeading {
  kind: "heading";
  level: number;
  /** Inline Markdown stripped. */
  text: string;
  lineStart: number;
  lineEnd: number;
  /** Heading path including this heading. */
  section: string[];
}

export interface MdListItem {
  /** Item text with continuation lines joined; inline Markdown kept. */
  text: string;
  lineStart: number;
  lineEnd: number;
  indent: number;
  ordered: boolean;
  children: MdListItem[];
}

export interface MdList {
  kind: "list";
  items: MdListItem[];
  lineStart: number;
  lineEnd: number;
  section: string[];
}

export interface MdCode {
  kind: "code";
  lang: string;
  content: string;
  /** Line of the opening fence. Content starts at lineStart + 1. */
  lineStart: number;
  lineEnd: number;
  section: string[];
}

export interface MdParagraph {
  kind: "paragraph";
  lines: MdLine[];
  text: string;
  lineStart: number;
  lineEnd: number;
  section: string[];
}

export type MdBlock = MdHeading | MdList | MdCode | MdParagraph;

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;

function indentWidth(ws: string): number {
  let width = 0;
  for (const ch of ws) width += ch === "\t" ? 4 - (width % 4) : 1;
  return width;
}

export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Small CommonMark-ish block tokenizer: headings, nested lists, fenced code, paragraphs. */
export function tokenizeMarkdown(text: string): MdBlock[] {
  const lines = splitLines(text);
  const blocks: MdBlock[] = [];
  const headingStack: { level: number; text: string }[] = [];
  const section = (): string[] => headingStack.map((h) => h.text);

  let paragraph: MdParagraph | undefined;
  let list: MdList | undefined;
  let itemStack: MdListItem[] = [];
  let lastItem: MdListItem | undefined;
  let blankSinceItem = false;

  const closeParagraph = () => {
    if (paragraph) blocks.push(paragraph);
    paragraph = undefined;
  };
  const closeList = () => {
    if (list) blocks.push(list);
    list = undefined;
    itemStack = [];
    lastItem = undefined;
    blankSinceItem = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const lineNo = i + 1;

    const fence = FENCE_OPEN.exec(raw);
    if (fence) {
      closeParagraph();
      closeList();
      const marker = fence[2]!;
      const lang = (fence[3] ?? "").toLowerCase();
      const body: string[] = [];
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j]!.trim();
        if (candidate.startsWith(marker[0]!.repeat(marker.length)) && /^(`+|~+)$/.test(candidate)) {
          end = j + 1;
          break;
        }
        body.push(lines[j]!);
      }
      blocks.push({ kind: "code", lang, content: body.join("\n"), lineStart: lineNo, lineEnd: end, section: section() });
      i = end - 1;
      continue;
    }

    if (raw.trim() === "") {
      closeParagraph();
      if (list) blankSinceItem = true;
      continue;
    }

    const heading = HEADING.exec(raw);
    if (heading) {
      closeParagraph();
      closeList();
      const level = heading[1]!.length;
      const headingText = stripInline((heading[2] ?? "").replace(/\s+#+\s*$/, ""));
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) headingStack.pop();
      headingStack.push({ level, text: headingText });
      blocks.push({ kind: "heading", level, text: headingText, lineStart: lineNo, lineEnd: lineNo, section: section() });
      continue;
    }

    if (THEMATIC_BREAK.test(raw)) {
      closeParagraph();
      closeList();
      continue;
    }

    const item = LIST_ITEM.exec(raw);
    if (item) {
      closeParagraph();
      const indent = indentWidth(item[1] ?? "");
      if (!list) {
        list = { kind: "list", items: [], lineStart: lineNo, lineEnd: lineNo, section: section() };
      }
      const node: MdListItem = {
        text: (item[3] ?? "").trim(),
        lineStart: lineNo,
        lineEnd: lineNo,
        indent,
        ordered: /\d/.test(item[2]!),
        children: [],
      };
      while (itemStack.length > 0 && itemStack[itemStack.length - 1]!.indent >= indent) itemStack.pop();
      const parent = itemStack[itemStack.length - 1];
      if (parent) parent.children.push(node);
      else list.items.push(node);
      for (const ancestor of itemStack) ancestor.lineEnd = lineNo;
      itemStack.push(node);
      list.lineEnd = lineNo;
      lastItem = node;
      blankSinceItem = false;
      continue;
    }

    if (list && lastItem) {
      const indent = indentWidth(/^\s*/.exec(raw)![0]);
      if (!blankSinceItem || indent >= 2) {
        lastItem.text = `${lastItem.text} ${raw.trim()}`.trim();
        lastItem.lineEnd = lineNo;
        for (const ancestor of itemStack) ancestor.lineEnd = lineNo;
        list.lineEnd = lineNo;
        continue;
      }
      closeList();
    }

    const content = raw.replace(/^ {0,3}>\s?/, "").trim();
    if (!paragraph) {
      paragraph = { kind: "paragraph", lines: [], text: "", lineStart: lineNo, lineEnd: lineNo, section: section() };
    }
    paragraph.lines.push({ text: content, line: lineNo });
    paragraph.text = paragraph.text ? `${paragraph.text} ${content}` : content;
    paragraph.lineEnd = lineNo;
  }
  closeParagraph();
  closeList();
  return blocks;
}

export function firstH1(blocks: MdBlock[]): string | undefined {
  for (const block of blocks) if (block.kind === "heading" && block.level === 1 && block.text) return block.text;
  return undefined;
}

export function sourceRef(
  snapshotId: string,
  lineStart: number,
  lineEnd: number,
  section: string[] | undefined,
  text?: string,
): SourceReference {
  const ref: SourceReference = { snapshotId, lineStart, lineEnd: Math.max(lineStart, lineEnd) };
  if (section && section.length > 0) ref.section = [...section];
  if (text !== undefined && text.trim() !== "") ref.excerpt = excerpt(text);
  return ref;
}

/** Text of an item and all descendants, depth-first. */
export function flattenItem(item: MdListItem): string[] {
  return [item.text, ...item.children.flatMap(flattenItem)];
}

/** A heading together with the blocks that belong to it (until the next heading of the same or higher level). */
export interface MdSection {
  heading: MdHeading;
  index: number;
  /** Blocks after the heading, including nested sub-headings. */
  body: MdBlock[];
  /** Blocks directly under the heading, before any sub-heading. */
  own: MdBlock[];
  lineEnd: number;
}

export function sectionsOf(blocks: MdBlock[]): MdSection[] {
  const out: MdSection[] = [];
  blocks.forEach((block, index) => {
    if (block.kind !== "heading") return;
    const body: MdBlock[] = [];
    const own: MdBlock[] = [];
    let ownOpen = true;
    for (let j = index + 1; j < blocks.length; j++) {
      const next = blocks[j]!;
      if (next.kind === "heading") {
        if (next.level <= block.level) break;
        ownOpen = false;
      }
      body.push(next);
      if (ownOpen) own.push(next);
    }
    const last = body[body.length - 1];
    out.push({ heading: block, index, body, own, lineEnd: last ? last.lineEnd : block.lineEnd });
  });
  return out;
}
