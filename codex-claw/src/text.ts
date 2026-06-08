export function splitReply(text: string, maxChars: number): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const chunks: string[] = [];
  let rest = normalized;
  while (rest.length > maxChars) {
    const slice = rest.slice(0, maxChars);
    const breakAt = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"), slice.lastIndexOf("。"), slice.lastIndexOf(". "));
    const cut = breakAt > Math.floor(maxChars * 0.5) ? breakAt + 1 : maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function mergeWaitingMessages(messages: string[]): string {
  const cleaned = messages.map((message) => message.trim()).filter(Boolean);
  if (cleaned.length <= 1) return cleaned[0] ?? "";
  return [
    "以下是用户在等待期间连续发送的消息，请作为同一个请求处理：",
    "",
    "---",
    cleaned.join("\n\n\n"),
    "---",
  ].join("\n");
}

export function pendingCharCount(messages: string[]): number {
  return messages.reduce((sum, message) => sum + message.length, 0);
}
