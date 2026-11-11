// A connection to the game server, over whichever transport worked.

export type LinkKind = 'webtransport' | 'websocket';

/** What a link reports to its owner. */
export interface LinkEvents {
  /** One server message (a snapshot may arrive out of order on WebTransport). */
  message(data: Uint8Array): void;
  /** The connection ended (only after it was open). */
  close(): void;
}

export interface Link {
  readonly kind: LinkKind;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(): void;
}
