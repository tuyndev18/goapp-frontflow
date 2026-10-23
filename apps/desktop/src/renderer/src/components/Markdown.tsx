import { useMemo } from "react";
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";

// GitHub-style rendering (github-markdown-css, mapped to the app theme in styles.css) with
// highlight.js for fenced code; unknown or missing languages are auto-detected.
const markdown = new Marked(
  { gfm: true, async: false },
  markedHighlight({
    emptyLangClass: "hljs",
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const language = lang && hljs.getLanguage(lang) ? lang : undefined;
      return language ? hljs.highlight(code, { language }).value : hljs.highlightAuto(code).value;
    },
  }),
);

/** Uploaded documents and AI output are untrusted (spec §9.1, §22.1): always sanitize before rendering. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => {
    const raw = markdown.parse(source) as string;
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "input", "iframe"], FORBID_ATTR: ["style"] });
  }, [source]);
  return <div className={`ff-markdown markdown-body${className ? ` ${className}` : ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
