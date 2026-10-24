/**
 * Prompt builders. Uploaded documents, Figma content and repository files are
 * untrusted (spec §22.1), so they are fenced as data and the model is told
 * not to follow instructions found inside them.
 */

export function untrusted(label: string, content: string, maxChars = 24_000): string {
  const body = content.length > maxChars ? `${content.slice(0, maxChars)}\n…(truncated)` : content;
  return `<untrusted-data source="${label}">\n${body.replace(/<\/untrusted-data>/gi, "</untrusted_data>")}\n</untrusted-data>`;
}
