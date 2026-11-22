import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { studentTypeLabels } from "../domain/volunteer.js";
import type {
  ReportEntry,
  ReportSort,
  StudentTypeFilter,
} from "../domain/volunteer-report.js";
import { groupByVolunteer, sumHours } from "./sorting.js";

const require = createRequire(import.meta.url);

const TEXT_COLOR = rgb(0.1, 0.1, 0.1);
const MUTED_COLOR = rgb(0.4, 0.4, 0.4);
const HEADER_FILL = rgb(0.92, 0.92, 0.92);
const SUMMARY_FILL = rgb(0.96, 0.96, 0.96);
const LINE_COLOR = rgb(0.8, 0.8, 0.8);
const FOOTER_SPACE = 28;

let fontBytes: { regular: Uint8Array; bold: Uint8Array } | null = null;

async function readFont(file: string): Promise<Uint8Array> {
  const candidates: string[] = [];

  try {
    candidates.push(require.resolve(`dejavu-fonts-ttf/ttf/${file}`));
  } catch {
    // Falls back to the project-relative path below.
  }
  candidates.push(join(process.cwd(), "node_modules/dejavu-fonts-ttf/ttf", file));

  for (const candidate of candidates) {
    try {
      return await readFile(candidate);
    } catch {
      // Try the next location.
    }
  }

  throw new Error(`Could not load the report font ${file}.`);
}

async function loadFontBytes(): Promise<{
  regular: Uint8Array;
  bold: Uint8Array;
}> {
  if (!fontBytes) {
    const [regular, bold] = await Promise.all([
      readFont("DejaVuSans.ttf"),
      readFont("DejaVuSans-Bold.ttf"),
    ]);
    fontBytes = { regular, bold };
  }

  return fontBytes;
}

function formatHours(hours: number): string {
  return String(Number(hours.toFixed(2)));
}

interface Column {
  header: string;
  width: number;
  align?: "left" | "right";
}

interface TableRow {
  cells: string[];
  kind: "data" | "summary";
}

class PdfBuilder {
  page!: PDFPage;
  y = 0;
  private readonly supported: Set<number>;

  private constructor(
    readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
    readonly pageSize: [number, number],
    readonly margin: number,
  ) {
    this.supported = new Set(font.getCharacterSet());
    this.addPage();
  }

  static async create(
    pageSize: [number, number],
    margin: number,
  ): Promise<PdfBuilder> {
    const bytes = await loadFontBytes();
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(bytes.regular, { subset: true });
    const bold = await doc.embedFont(bytes.bold, { subset: true });

    return new PdfBuilder(doc, font, bold, pageSize, margin);
  }

  get contentWidth(): number {
    return this.pageSize[0] - this.margin * 2;
  }

  get bottom(): number {
    return this.margin + FOOTER_SPACE;
  }

  addPage(): void {
    this.page = this.doc.addPage(this.pageSize);
    this.y = this.pageSize[1] - this.margin;
  }

  clean(text: string): string {
    let result = "";

    for (const character of text.replace(/[\u0000-\u001F\u007F]+/g, " ")) {
      const codePoint = character.codePointAt(0) ?? 0;
      result += this.supported.has(codePoint) ? character : "?";
    }

    return result.replace(/\s+/g, " ").trim();
  }

  wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const lines: string[] = [];
    let line = "";

    const flush = () => {
      if (line) {
        lines.push(line);
        line = "";
      }
    };

    for (const word of this.clean(text).split(" ")) {
      if (!word) {
        continue;
      }

      const candidate = line ? `${line} ${word}` : word;

      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }

      flush();

      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        line = word;
        continue;
      }

      let piece = "";
      for (const character of word) {
        if (font.widthOfTextAtSize(piece + character, size) > maxWidth) {
          lines.push(piece);
          piece = character;
        } else {
          piece += character;
        }
      }
      line = piece;
    }

    flush();

    return lines.length > 0 ? lines : [""];
  }

  text(
    value: string,
    options: {
      x?: number;
      size?: number;
      bold?: boolean;
      color?: ReturnType<typeof rgb>;
      maxWidth?: number;
      align?: "left" | "right";
    } = {},
  ): void {
    const size = options.size ?? 10;
    const font = options.bold ? this.bold : this.font;
    const maxWidth = options.maxWidth ?? this.contentWidth;
    const x = options.x ?? this.margin;

    for (const line of this.wrap(value, font, size, maxWidth)) {
      if (this.y - size * 1.4 < this.bottom) {
        this.addPage();
      }

      this.y -= size * 1.4;
      const offset =
        options.align === "right"
          ? maxWidth - font.widthOfTextAtSize(line, size)
          : 0;

      this.page.drawText(line, {
        x: x + offset,
        y: this.y,
        size,
        font,
        color: options.color ?? TEXT_COLOR,
      });
    }
  }

  gap(height: number): void {
    this.y -= height;
  }

  rule(): void {
    this.page.drawLine({
      start: { x: this.margin, y: this.y },
      end: { x: this.margin + this.contentWidth, y: this.y },
      thickness: 0.8,
      color: LINE_COLOR,
    });
  }

  private drawRow(
    columns: Column[],
    cells: string[],
    style: { bold: boolean; fill: ReturnType<typeof rgb> | null; size: number },
  ): number {
    const padding = 4;
    const lineHeight = style.size * 1.3;
    const font = style.bold ? this.bold : this.font;
    const wrapped = columns.map((column, index) =>
      this.wrap(
        cells[index] ?? "",
        font,
        style.size,
        column.width - padding * 2,
      ),
    );
    const lineCount = Math.max(...wrapped.map((lines) => lines.length));
    const height = padding * 2 + lineCount * lineHeight;
    const top = this.y;

    if (style.fill) {
      this.page.drawRectangle({
        x: this.margin,
        y: top - height,
        width: columns.reduce((sum, column) => sum + column.width, 0),
        height,
        color: style.fill,
      });
    }

    let x = this.margin;
    columns.forEach((column, index) => {
      (wrapped[index] ?? []).forEach((line, lineIndex) => {
        const lineWidth = font.widthOfTextAtSize(line, style.size);

        this.page.drawText(line, {
          x:
            column.align === "right"
              ? x + column.width - padding - lineWidth
              : x + padding,
          y: top - padding - style.size - lineIndex * lineHeight,
          size: style.size,
          font,
          color: TEXT_COLOR,
        });
      });
      x += column.width;
    });

    this.page.drawLine({
      start: { x: this.margin, y: top - height },
      end: {
        x: this.margin + columns.reduce((sum, column) => sum + column.width, 0),
        y: top - height,
      },
      thickness: 0.4,
      color: LINE_COLOR,
    });

    this.y -= height;
    return height;
  }

  table(columns: Column[], rows: TableRow[], size = 8.5): void {
    const drawHeader = () =>
      this.drawRow(
        columns,
        columns.map((column) => column.header),
        { bold: true, fill: HEADER_FILL, size },
      );

    // Keeps the header and at least one row together at the bottom of a page.
    if (this.y - 40 < this.bottom) {
      this.addPage();
    }
    drawHeader();

    for (const row of rows) {
      const font = row.kind === "summary" ? this.bold : this.font;
      const padding = 4;
      const estimate =
        padding * 2 +
        Math.max(
          ...columns.map(
            (column, index) =>
              this.wrap(
                row.cells[index] ?? "",
                font,
                size,
                column.width - padding * 2,
              ).length,
          ),
        ) *
          size *
          1.3;

      if (this.y - estimate < this.bottom) {
        this.addPage();
        drawHeader();
      }

      this.drawRow(columns, row.cells, {
        bold: row.kind === "summary",
        fill: row.kind === "summary" ? SUMMARY_FILL : null,
        size,
      });
    }
  }

  async save(footerLeft: string): Promise<Uint8Array> {
    const pages = this.doc.getPages();

    pages.forEach((page, index) => {
      const label = `Page ${index + 1} of ${pages.length}`;
      const width = this.font.widthOfTextAtSize(label, 8);

      page.drawText(this.clean(footerLeft), {
        x: this.margin,
        y: this.margin,
        size: 8,
        font: this.font,
        color: MUTED_COLOR,
      });
      page.drawText(label, {
        x: this.pageSize[0] - this.margin - width,
        y: this.margin,
        size: 8,
        font: this.font,
        color: MUTED_COLOR,
      });
    });

    return this.doc.save();
  }
}

export interface CombinedReportInput {
  entries: ReportEntry[];
  sort: ReportSort;
  yearLabel: string;
  studentType: StudentTypeFilter;
  onlyUnsent: boolean;
  generatedOn: string;
  organizationName: string;
}

export async function buildCombinedReportPdf(
  input: CombinedReportInput,
): Promise<Uint8Array> {
  const builder = await PdfBuilder.create([841.89, 595.28], 36);
  const includeStudentDetails = input.studentType !== "uoft";

  const fixed = includeStudentDetails
    ? { date: 62, hours: 46, name: 112, type: 76, id: 118, category: 100 }
    : { date: 62, hours: 46, name: 120, type: 70, id: 70, category: 110 };
  const activityWidth =
    builder.contentWidth -
    (fixed.date + fixed.hours + fixed.name + fixed.type + fixed.id + fixed.category);

  const columns: Column[] = includeStudentDetails
    ? [
        { header: "Date", width: fixed.date },
        { header: "Hours", width: fixed.hours, align: "right" },
        { header: "Name", width: fixed.name },
        { header: "Student type", width: fixed.type },
        { header: "UTORid / student #", width: fixed.id },
        { header: "Category", width: fixed.category },
        { header: "What was done", width: activityWidth },
      ]
    : [
        { header: "Date", width: fixed.date },
        { header: "Hours", width: fixed.hours, align: "right" },
        { header: "Name", width: fixed.name },
        { header: "UTORid", width: fixed.type },
        { header: "Student #", width: fixed.id },
        { header: "Category", width: fixed.category },
        { header: "What was done", width: activityWidth },
      ];

  const dataCells = (entry: ReportEntry): string[] => {
    const category = entry.eventName
      ? `${entry.categoryName}: ${entry.eventName}`
      : entry.categoryName;

    return includeStudentDetails
      ? [
          entry.entryDate,
          formatHours(entry.hours),
          entry.fullName,
          studentTypeLabels[entry.studentType],
          entry.studentType === "uoft"
            ? `${entry.utorid ?? ""} / ${entry.studentNumber}`
            : entry.studentNumber,
          category,
          entry.description,
        ]
      : [
          entry.entryDate,
          formatHours(entry.hours),
          entry.fullName,
          entry.utorid ?? "",
          entry.studentNumber,
          category,
          entry.description,
        ];
  };

  const summaryCells = (hours: number, label: string): string[] => {
    const cells = new Array<string>(columns.length).fill("");
    cells[1] = formatHours(hours);
    cells[2] = label;

    return cells;
  };

  const rows: TableRow[] = [];

  if (input.sort === "name") {
    for (const group of groupByVolunteer(input.entries).values()) {
      for (const entry of group) {
        rows.push({ cells: dataCells(entry), kind: "data" });
      }

      rows.push({
        cells: summaryCells(
          sumHours(group),
          `Subtotal: ${group[0]?.fullName ?? ""}`,
        ),
        kind: "summary",
      });
    }
  } else {
    for (const entry of input.entries) {
      rows.push({ cells: dataCells(entry), kind: "data" });
    }
  }

  const volunteerCount = groupByVolunteer(input.entries).size;
  rows.push({
    cells: summaryCells(
      sumHours(input.entries),
      `Total: ${input.entries.length} entries, ${volunteerCount} volunteer${volunteerCount === 1 ? "" : "s"}`,
    ),
    kind: "summary",
  });

  const studentsLabel =
    input.studentType === "all"
      ? "All students"
      : `${studentTypeLabels[input.studentType]}s only`;

  builder.text(`${input.organizationName} Volunteer Hours Report`, {
    size: 16,
    bold: true,
  });
  builder.text(input.yearLabel, { size: 12 });
  builder.text(
    `${studentsLabel}  ·  ${input.onlyUnsent ? "Entries not yet sent to CCR" : "All approved entries"}  ·  Sorted by ${input.sort}  ·  Generated ${input.generatedOn}`,
    { size: 9, color: MUTED_COLOR },
  );
  builder.gap(8);

  builder.table(columns, rows);

  return builder.save(`${input.organizationName} · ${input.yearLabel}`);
}

export interface LetterheadConfig {
  organizationName: string;
  contactLine: string | null;
  logo: Uint8Array | null;
}

export interface LetterheadSignatory {
  name: string;
  title: string;
}

export interface LetterheadInput {
  entries: ReportEntry[];
  yearLabel: string;
  generatedOn: string;
  config: LetterheadConfig;
  signatory: LetterheadSignatory;
}

export async function buildLetterheadPdf(
  input: LetterheadInput,
): Promise<Uint8Array> {
  const first = input.entries[0];

  if (!first) {
    throw new Error("A letterhead needs at least one approved entry.");
  }

  const { config } = input;
  const builder = await PdfBuilder.create([595.28, 841.89], 56);

  if (config.logo) {
    try {
      const logo = await builder.doc
        .embedPng(config.logo)
        .catch(() => builder.doc.embedJpg(config.logo as Uint8Array));
      const scale = Math.min(48 / logo.height, 160 / logo.width);

      builder.page.drawImage(logo, {
        x: builder.margin,
        y: builder.y - logo.height * scale,
        width: logo.width * scale,
        height: logo.height * scale,
      });
      builder.gap(logo.height * scale + 8);
    } catch {
      // A bad logo file shouldn't stop the letter from being generated.
    }
  }

  builder.text(config.organizationName, { size: 18, bold: true });
  builder.text("Volunteer Hours Confirmation", { size: 11, color: MUTED_COLOR });
  builder.gap(4);
  builder.rule();
  builder.gap(12);
  builder.text(input.generatedOn, { size: 10, align: "right" });
  builder.gap(10);
  builder.text("To whom it may concern,", { size: 11 });
  builder.gap(6);

  const identity =
    first.studentType === "uoft"
      ? `${first.fullName} (UTORid: ${first.utorid ?? "n/a"}, student number: ${first.studentNumber})`
      : `${first.fullName} (${first.studentType === "high_school" ? "student number" : "student ID"}: ${first.studentNumber})`;

  builder.text(
    `This letter confirms that ${identity} volunteered with ${config.organizationName} during the ${input.yearLabel}. The hours listed below were reviewed and approved by ${config.organizationName}.`,
    { size: 11 },
  );
  builder.gap(10);

  const dateWidth = 70;
  const hoursWidth = 46;
  const columns: Column[] = [
    { header: "Date", width: dateWidth },
    { header: "Hours", width: hoursWidth, align: "right" },
    {
      header: "Activity",
      width: builder.contentWidth - dateWidth - hoursWidth,
    },
  ];
  const rows: TableRow[] = input.entries.map((entry) => ({
    kind: "data",
    cells: [
      entry.entryDate,
      formatHours(entry.hours),
      `${entry.eventName ? `${entry.categoryName}: ${entry.eventName}` : entry.categoryName}: ${entry.description}`,
    ],
  }));
  rows.push({
    kind: "summary",
    cells: ["Total", formatHours(sumHours(input.entries)), ""],
  });

  builder.table(columns, rows, 9.5);
  builder.gap(18);

  builder.text("Sincerely,", { size: 11 });
  builder.gap(34);
  builder.text("______________________________", { size: 11 });

  builder.text(input.signatory.name, { size: 11, bold: true });
  builder.text(input.signatory.title, { size: 10 });

  builder.text(config.organizationName, { size: 10 });

  if (config.contactLine) {
    builder.gap(6);
    builder.text(config.contactLine, { size: 9, color: MUTED_COLOR });
  }

  return builder.save(`${config.organizationName} · ${first.fullName}`);
}
