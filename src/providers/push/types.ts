// The push provider: what the app needs from whichever service delivers
// push notifications. Firebase Cloud Messaging arrives in Phase 10.2.
//
// Rule from document 03 section 4.4: a push carries no health values. The
// title and body are composed by the caller from ids and counts only.

export interface PushMessage {
  // The device's registration token.
  token: string;
  title: string;
  body: string;
  // Small string values the app uses to open the right screen.
  data?: Record<string, string>;
}

export type PushResult =
  | { status: 'sent' }
  // The token is no longer valid; the caller removes it from the device.
  | { status: 'invalid_token' }
  | { status: 'failed'; error: string };

export interface PushProvider {
  send(message: PushMessage): Promise<PushResult>;
}
