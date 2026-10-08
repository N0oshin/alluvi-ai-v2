// The email provider: what the app needs from whichever service sends mail.

export interface EmailMessage {
  to: string;
  subject: string;
  // Plain text is required; HTML is optional and carries the same content.
  text: string;
  html?: string;
}

export interface EmailProvider {
  // Resolves once the vendor has accepted the message. Throws on refusal, so
  // the caller (a job, usually) can retry.
  send(message: EmailMessage): Promise<{ messageId: string }>;
}
