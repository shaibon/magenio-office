import { classifyN8nTokenCheck, type N8nTokenCheck } from '../shared/mcpCatalog';

const MAX_BODY = 65536;

/** Body text of a JSON reply, or the first complete SSE `data:` event, capped in size; the
 *  caller's abort signal bounds the time. Any other content type yields no body. */
async function readReply(res: Response): Promise<string | undefined> {
  const type = res.headers.get('content-type') ?? '';
  if (!res.body || !/json|event-stream/i.test(type)) return undefined;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      if (text.length >= MAX_BODY || (/event-stream/i.test(type) && /^data:.*\n/m.test(text))) break;
    }
  } finally { void reader.cancel().catch(() => undefined); }
  return text.slice(0, MAX_BODY);
}

/** One MCP `initialize` POST with the bearer; the token is used here and never returned. */
export async function checkN8nToken(url: string, token: string, version: string, timeoutMs = 5000): Promise<N8nTokenCheck> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'munder-difflin', version } } })
    });
    const ok = res.status >= 200 && res.status < 300;
    if (!ok) void res.body?.cancel().catch(() => undefined);
    return classifyN8nTokenCheck(res.status, ok ? await readReply(res) : undefined);
  } catch { return classifyN8nTokenCheck(null); }
}
