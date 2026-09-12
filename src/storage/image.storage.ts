export interface ImageUpload {
  originalName: string;
  mimeType: string;
  sizeBytes: number | null;
  body: ReadableStream<Uint8Array>;
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
