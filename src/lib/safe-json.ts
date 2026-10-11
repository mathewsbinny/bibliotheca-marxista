/**
 * JSON for embedding in a <script> element. JSON.stringify leaves "<", ">" and "&" as they are, so
 * a value containing "</script>" or "<!--" would end the element early; written as \u003c and so on,
 * the JSON parses to the same data and cannot break out.
 */
const ESCAPES: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => ESCAPES[c]);
}
