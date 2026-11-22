/**
 * Shared by the view tests (not used at runtime): the checks Slack applies to
 * a modal or message before it accepts it.
 */
/**
 * Slack rejects a modal or message that breaks its documented limits, and it
 * does so at runtime, where a typo or an unusually large list only shows up
 * for a real user. These checks run every view the bot builds, with worst-case
 * data, against those limits.
 */
export type Json = Record<string, unknown>;

export const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const text = (value: unknown): string =>
  isObject(value) && typeof value.text === "string" ? value.text : "";

function checkOptions(
  element: Json,
  where: string,
  problems: string[],
  maxOptions: number,
): void {
  const options = Array.isArray(element.options) ? (element.options as Json[]) : [];

  if (options.length > maxOptions) {
    problems.push(`${where}: ${options.length} options (max ${maxOptions})`);
  }
  if (options.length === 0 && !Array.isArray(element.option_groups)) {
    problems.push(`${where}: ${String(element.type)} with no options`);
  }

  for (const option of options) {
    if (text(option.text).length > 75) {
      problems.push(`${where}: option text over 75 chars: "${text(option.text)}"`);
    }
    if (text(option.text).length === 0) {
      problems.push(`${where}: option with empty text`);
    }
    if (typeof option.value === "string" && option.value.length > 150) {
      problems.push(`${where}: option value over 150 chars`);
    }
    if (text(option.description).length > 75) {
      problems.push(
        `${where}: option description over 75 chars (${text(option.description).length}): "${text(option.description)}"`,
      );
    }
  }

  const initial = element.initial_option;
  if (isObject(initial) && !options.some((option) => option.value === initial.value)) {
    problems.push(`${where}: initial_option "${String(initial.value)}" is not one of the options`);
  }
}

function checkElement(element: Json, where: string, problems: string[]): void {
  const type = String(element.type);
  const actionId = String(element.action_id ?? "");

  if (actionId.length > 255) {
    problems.push(`${where}: action_id over 255 chars`);
  }
  if (text(element.placeholder).length > 150) {
    problems.push(`${where}: placeholder over 150 chars`);
  }

  switch (type) {
    case "plain_text_input": {
      const max = typeof element.max_length === "number" ? element.max_length : 3000;
      if (max > 3000) problems.push(`${where}: max_length ${max} over 3000`);
      const initial = typeof element.initial_value === "string" ? element.initial_value : "";
      if (initial.length > max) {
        problems.push(`${where}: initial_value (${initial.length}) longer than max_length (${max})`);
      }
      break;
    }
    case "static_select":
    case "multi_static_select":
      checkOptions(element, where, problems, 100);
      break;
    case "radio_buttons":
    case "checkboxes":
      checkOptions(element, where, problems, 10);
      break;
    case "datepicker":
      if (
        element.initial_date !== undefined &&
        !/^\d{4}-\d{2}-\d{2}$/.test(String(element.initial_date))
      ) {
        problems.push(`${where}: initial_date "${String(element.initial_date)}" is not YYYY-MM-DD`);
      }
      break;
    case "number_input": {
      if (element.initial_value !== undefined) {
        const value = Number(element.initial_value);
        if (!Number.isFinite(value)) {
          problems.push(`${where}: number_input initial_value "${String(element.initial_value)}" is not a number`);
        } else if (
          value < Number(element.min_value ?? -Infinity) ||
          value > Number(element.max_value ?? Infinity)
        ) {
          problems.push(`${where}: number_input initial_value ${value} outside min/max`);
        }
      }
      break;
    }
    case "button":
      if (text(element.text).length > 75) problems.push(`${where}: button text over 75 chars`);
      if (text(element.text).length === 0) problems.push(`${where}: button with empty text`);
      if (isObject(element.confirm)) {
        const confirm = element.confirm;
        if (text(confirm.title).length === 0 || text(confirm.title).length > 100) {
          problems.push(`${where}: confirm title empty or over 100 chars`);
        }
        if (text(confirm.text).length === 0 || text(confirm.text).length > 300) {
          problems.push(`${where}: confirm text empty or over 300 chars`);
        }
        if (text(confirm.confirm).length === 0 || text(confirm.confirm).length > 30) {
          problems.push(`${where}: confirm button empty or over 30 chars`);
        }
        if (text(confirm.deny).length === 0 || text(confirm.deny).length > 30) {
          problems.push(`${where}: confirm deny button empty or over 30 chars`);
        }
      }
      if (typeof element.value === "string" && element.value.length > 2000) {
        problems.push(`${where}: button value over 2000 chars`);
      }
      break;
    default:
      break;
  }
}

export function checkView(
  view: Json,
  name: string,
  kind: "modal" | "message",
): string[] {
  const problems: string[] = [];
  const blocks = (view.blocks as Json[] | undefined) ?? [];
  const maxBlocks = kind === "modal" ? 100 : 50;

  if (kind === "modal") {
    for (const field of ["title", "submit", "close"] as const) {
      if (view[field] !== undefined && text(view[field]).length > 24) {
        problems.push(`${field} over 24 chars: "${text(view[field])}"`);
      }
    }
    if (text(view.title).length === 0) problems.push("modal has no title");
    if (typeof view.private_metadata === "string" && view.private_metadata.length > 3000) {
      problems.push(`private_metadata is ${view.private_metadata.length} chars (max 3000)`);
    }
  }

  if (blocks.length > maxBlocks) {
    problems.push(`${blocks.length} blocks (max ${maxBlocks})`);
  }

  const seen = new Set<string>();
  blocks.forEach((block, index) => {
    const where = `block ${index} (${String(block.type)})`;
    const blockId = typeof block.block_id === "string" ? block.block_id : null;

    if (blockId) {
      if (blockId.length > 255) problems.push(`${where}: block_id over 255 chars`);
      if (seen.has(blockId)) problems.push(`${where}: duplicate block_id "${blockId}"`);
      seen.add(blockId);
    }

    switch (block.type) {
      case "header": {
        if (text(block.text).length === 0 || text(block.text).length > 150) {
          problems.push(`${where}: header text empty or over 150 chars`);
        }
        break;
      }
      case "section": {
        if (text(block.text).length > 3000) {
          problems.push(`${where}: text is ${text(block.text).length} chars (max 3000)`);
        }
        if (block.text !== undefined && text(block.text).length === 0) {
          problems.push(`${where}: section text is empty`);
        }
        const fields = (block.fields as Json[] | undefined) ?? [];
        if (fields.length > 10) problems.push(`${where}: ${fields.length} fields (max 10)`);
        for (const field of fields) {
          if (text(field).length > 2000) problems.push(`${where}: a field is over 2000 chars`);
        }
        if (block.text === undefined && fields.length === 0) {
          problems.push(`${where}: section with neither text nor fields`);
        }
        break;
      }
      case "context": {
        const elements = (block.elements as Json[] | undefined) ?? [];
        if (elements.length > 10) problems.push(`${where}: ${elements.length} elements (max 10)`);
        if (elements.length === 0) problems.push(`${where}: context with no elements`);
        break;
      }
      case "actions": {
        const elements = (block.elements as Json[] | undefined) ?? [];
        if (elements.length > 25) problems.push(`${where}: ${elements.length} elements (max 25)`);
        if (elements.length === 0) problems.push(`${where}: actions with no elements`);
        // Slack rejects the whole view ("invalid_arguments") when two elements
        // in one row share an action_id. (Across different blocks it's fine.)
        const rowActionIds = new Set<string>();
        elements.forEach((element, elementIndex) => {
          checkElement(element, `${where} element ${elementIndex}`, problems);
          const actionId = typeof element.action_id === "string" ? element.action_id : null;
          if (actionId) {
            if (rowActionIds.has(actionId)) {
              problems.push(
                `${where} element ${elementIndex}: duplicate action_id "${actionId}" in the same row`,
              );
            }
            rowActionIds.add(actionId);
          }
        });
        break;
      }
      case "input": {
        if (text(block.label).length > 2000 || text(block.label).length === 0) {
          problems.push(`${where}: label empty or over 2000 chars`);
        }
        if (text(block.hint).length > 2000) problems.push(`${where}: hint over 2000 chars`);
        if (isObject(block.element)) {
          checkElement(block.element, where, problems);
        } else {
          problems.push(`${where}: input without an element`);
        }
        break;
      }
      default:
        break;
    }
  });

  // A modal with an input block needs a submit button, or Slack refuses it.
  if (
    kind === "modal" &&
    blocks.some((block) => block.type === "input") &&
    view.submit === undefined
  ) {
    problems.push("modal has input blocks but no submit button");
  }

  return problems.map((problem) => `[${name}] ${problem}`);
}
