import type { RawMail } from '../../shared/mail';

/** What a provider needs to know about an account. The password is passed
 *  separately, once, and is never part of anything that is stored or logged. */
export interface MailAccountConn {
  host: string; port: number; username: string; mailbox: string;
}

export interface FetchResult {
  messages: RawMail[];
  uidValidity: number | null;
}

/**
 * READ-ONLY mailbox access. There is deliberately no send, draft, flag, move or
 * delete here: a provider can list and fetch, nothing else.
 */
export interface MailProvider {
  /** Messages with UID greater than `lastUid`, oldest first, at most `limit`. */
  fetchSince(lastUid: number, limit: number): Promise<FetchResult>;
  close(): Promise<void>;
}

export type MailProviderFactory = (conn: MailAccountConn, password: string) => MailProvider;
