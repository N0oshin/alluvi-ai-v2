// The storage provider: what the app needs from whichever service holds
// photos (document 04 section 1.5 and 5.1).
//
// Photos never pass through the API. The phone asks for an upload URL, PUTs
// the file straight to storage, then tells the API it is done. Reading works
// the same way with a short-lived download URL. The S3 implementation comes
// with the next Phase 1.5 item; this interface and the fake come first.

export interface UploadRequest {
  // Where the object will live, chosen by the server: 'media/<user>/<id>.jpg'.
  key: string;
  // The only content type the URL accepts.
  contentType: string;
  // The largest body the URL accepts, in bytes.
  maxBytes: number;
}

export interface UploadTarget {
  url: string;
  method: 'PUT';
  // Headers the phone must send exactly, or the upload is refused.
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface DownloadTarget {
  url: string;
  expiresAt: Date;
}

export interface StorageProvider {
  // A single-use URL, valid 10 minutes, for one object of the given type and size.
  createUploadUrl(request: UploadRequest): Promise<UploadTarget>;
  // A URL to read one object, valid 5 minutes.
  createDownloadUrl(key: string): Promise<DownloadTarget>;
  // Whether the phone really uploaded the object.
  exists(key: string): Promise<boolean>;
  // Idempotent: deleting a missing object is not an error.
  delete(key: string): Promise<void>;
}

export const UPLOAD_URL_TTL_MS = 10 * 60 * 1000;
export const DOWNLOAD_URL_TTL_MS = 5 * 60 * 1000;
