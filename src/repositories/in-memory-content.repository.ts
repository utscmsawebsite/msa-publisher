import type { Content } from "../domain/content.js";
import type { ContentRepository } from "./content.repository.js";

export class InMemoryContentRepository implements ContentRepository {
  private readonly contents = new Map<string, Content>();

  async save(content: Content): Promise<Content> {
    this.contents.set(content.id, content);
    return content;
  }
}
