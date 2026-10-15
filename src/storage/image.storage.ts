import type { Buffer } from "node:buffer";

export interface ImageUpload {
  originalName: string;
  mimeType: string;
  sizeBytes: number | null;
  body: Buffer;
}

export interface StoredImage {
  url: string;
  pathname: string;
}

export interface ImageStorage {
  saveEventImage(
    eventId: string,
    position: number,
    image: ImageUpload,
  ): Promise<StoredImage>;

  delete(pathnames: string[]): Promise<void>;
}
