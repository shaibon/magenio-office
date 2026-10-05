/**
 * Decide, from a message's BODYSTRUCTURE alone, which parts to download.
 *
 * Only inline text/plain and text/html parts are ever fetched; everything else
 * (attachments, images, archives) is described and never downloaded. Pure, so the
 * rule is testable without a mail server.
 */

export interface BodyNode {
  part?: string;
  type?: string;
  size?: number;
  disposition?: string;
  parameters?: Record<string, string>;
  dispositionParameters?: Record<string, string>;
  childNodes?: BodyNode[];
}

export interface TextPart { part: string; type: 'text/plain' | 'text/html'; charset: string; size: number }
export interface AttachmentMeta { filename: string; contentType: string; size: number }
export interface PartPlan { text: TextPart[]; attachments: AttachmentMeta[] }

/** A text part larger than this is skipped, not truncated mid-character. */
export const MAX_TEXT_PART_BYTES = 1024 * 1024;

export function planParts(root: BodyNode | undefined): PartPlan {
  const plan: PartPlan = { text: [], attachments: [] };
  const walk = (n: BodyNode, single: boolean): void => {
    if (n.childNodes?.length) { for (const c of n.childNodes) walk(c, false); return; }
    const type = (n.type ?? '').toLowerCase();
    if (type.startsWith('multipart/')) return;
    // A part with a file name is an attachment even without a Content-Disposition;
    // only unnamed inline text is the message body.
    const named = !!(n.dispositionParameters?.filename || n.parameters?.name);
    const attachment = (n.disposition ?? '').toLowerCase() === 'attachment' || named;
    if (!attachment && (type === 'text/plain' || type === 'text/html')) {
      if ((n.size ?? 0) <= MAX_TEXT_PART_BYTES) {
        plan.text.push({ part: n.part || (single ? '1' : ''), type, charset: n.parameters?.charset || 'utf-8', size: n.size ?? 0 });
      }
      return;
    }
    plan.attachments.push({
      filename: n.dispositionParameters?.filename || n.parameters?.name || '',
      contentType: type || 'application/octet-stream',
      size: n.size ?? 0
    });
  };
  if (root) walk(root, true);
  plan.text = plan.text.filter((t) => t.part);
  return plan;
}

/** Unfold and index a raw header block (only the few headers we ask for). */
export function parseHeaderBlock(raw: Buffer | string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const text = (typeof raw === 'string' ? raw : raw?.toString('utf8') ?? '').replace(/\r?\n[ \t]+/g, ' ');
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return out;
}
