import type { JummahContent, JummahDraft } from "../domain/jummah.js";

export interface JummahRepository {
  getCurrent(): Promise<JummahContent | null>;
  upsert(draft: JummahDraft): Promise<JummahContent>;
}
