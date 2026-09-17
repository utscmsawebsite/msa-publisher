import type {
  JummahContent,
  JummahDraft,
  JummahUnavailableDraft,
} from "../domain/jummah.js";

export interface JummahRepository {
  getCurrent(): Promise<JummahContent | null>;
  upsert(draft: JummahDraft): Promise<JummahContent>;
  markUnavailable(draft: JummahUnavailableDraft): Promise<JummahContent>;
}
