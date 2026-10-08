// The fake storage provider: a Map of keys in memory. A test "uploads" by
// calling put(key), which is what the phone's PUT would do against S3.

import {
  DOWNLOAD_URL_TTL_MS,
  UPLOAD_URL_TTL_MS,
  type StorageProvider,
  type UploadRequest,
} from './types.js';

export interface FakeStorage extends StorageProvider {
  readonly objects: Map<string, { contentType: string; bytes: number }>;
  readonly uploadRequests: UploadRequest[];
  // Stands in for the phone's PUT to the upload URL.
  put(key: string, contentType?: string, bytes?: number): void;
}

export function fakeStorage(): FakeStorage {
  const objects = new Map<string, { contentType: string; bytes: number }>();
  const uploadRequests: UploadRequest[] = [];

  return {
    objects,
    uploadRequests,
    put(key, contentType = 'image/jpeg', bytes = 1024) {
      objects.set(key, { contentType, bytes });
    },
    createUploadUrl(request) {
      uploadRequests.push(request);
      return Promise.resolve({
        url: `https://fake-storage.local/upload/${encodeURIComponent(request.key)}`,
        method: 'PUT',
        headers: { 'Content-Type': request.contentType },
        expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_MS),
      });
    },
    createDownloadUrl(key) {
      return Promise.resolve({
        url: `https://fake-storage.local/download/${encodeURIComponent(key)}`,
        expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_MS),
      });
    },
    exists(key) {
      return Promise.resolve(objects.has(key));
    },
    delete(key) {
      objects.delete(key);
      return Promise.resolve();
    },
  };
}
