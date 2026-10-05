/**
 * Owns the blob: URLs behind composer thumbnails so every one is revoked exactly
 * once — on remove, on send, on a failed paste and on unmount. Create/revoke are
 * injected so this stays DOM-free and testable.
 */
export class ThumbRegistry {
  private live = new Set<string>();
  constructor(
    private readonly create: (blob: Blob) => string,
    private readonly revoke: (url: string) => void
  ) {}

  add(blob: Blob): string {
    const url = this.create(blob);
    this.live.add(url);
    return url;
  }

  /** Idempotent: releasing an unknown or already-released URL does nothing. */
  release(url: string | undefined): void {
    if (url && this.live.delete(url)) this.revoke(url);
  }

  releaseAll(): void {
    for (const url of this.live) this.revoke(url);
    this.live.clear();
  }

  get size(): number { return this.live.size; }
}
