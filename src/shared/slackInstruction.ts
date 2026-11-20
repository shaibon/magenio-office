/**
 * T139 g3 · The instruction that reaches god, and the choice that makes it safe.
 *
 * For a human request the instruction is preamble + text. For a bot notice the preamble already
 * **contains** the text between the delimiters: appending it again would put it back outside them,
 * where it would read as an instruction. The rule lives in a pure function, so it holds everywhere.
 */

export interface GodInstructionInput {
  autonomyPreamble?: string;
  text: string;
  fromTrustedBot?: string;
}

export function buildGodInstruction(input: GodInstructionInput): string | undefined {
  if (!input.autonomyPreamble) return undefined;
  // The bot text is already inside the preamble, between the delimiters: it is not appended again.
  if (input.fromTrustedBot) return input.autonomyPreamble;
  return `${input.autonomyPreamble}${input.text}`;
}

export interface SlackIpcMessage {
  text: string;
  channel: string;
  ts: string;
  thread_ts: string;
  autonomyPreamble: string;
  fromTrustedBot?: string;
  files?: unknown[];
}

export interface SlackIpcInput {
  text: string;
  channel: string;
  ts: string;
  thread_ts: string;
  fromTrustedBot?: string;
  files?: unknown[];
  buildPreamble: () => string;
}

/**
 * The message main sends to the renderer. `text` stays for the card title and description; the
 * provenance travels as a structured field, not as a sentence inside the text.
 */
export function buildSlackIpcMessage(input: SlackIpcInput): SlackIpcMessage {
  const msg: SlackIpcMessage = {
    text: input.text,
    channel: input.channel,
    ts: input.ts,
    thread_ts: input.thread_ts,
    autonomyPreamble: input.buildPreamble(),
  };
  if (input.fromTrustedBot) msg.fromTrustedBot = input.fromTrustedBot;
  if (input.files && input.files.length > 0) msg.files = input.files;
  return msg;
}
