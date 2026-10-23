import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

/** Uploaded documents and AI output are untrusted (spec §9.1, §22.1): always sanitize before rendering. */
export function Markdown({ source }: { source: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(source, { async: false, gfm: true }) as string;
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "input", "iframe"], FORBID_ATTR: ["style"] });
  }, [source]);
  return <div className="ff-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
