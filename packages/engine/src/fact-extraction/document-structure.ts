export type DocumentBlockKind = "section" | "clause" | "table" | "table_row" | "formula" | "definition" | "appendix" | "note";

export interface DocumentStructureBlock {
  id: string;
  kind: DocumentBlockKind;
  sourceId: string;
  sectionPath: string[];
  clauseNo?: string;
  tableNo?: string;
  formulaNo?: string;
  heading?: string;
  rowIndex?: number;
  cells?: string[];
  headers?: string[];
  rawText: string;
  normalizedText: string;
  startOffset?: number;
  endOffset?: number;
}

function stripMarkup(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitMarkdownRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map(stripMarkup)
    .filter(Boolean);
}

function isMarkdownDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function tableNoFromText(text: string): string | undefined {
  return stripMarkup(text).match(/表\s*([0-9一二三四五六七八九十]+(?:[-.][0-9]+)?)/u)?.[0];
}

function formulaNoFromText(text: string): string | undefined {
  return stripMarkup(text).match(/(?:式|公式)\s*[(（]?([0-9一二三四五六七八九十]+(?:[-.][0-9]+)?)[)）]?/u)?.[0];
}

function clauseNoFromText(text: string): string | undefined {
  return stripMarkup(text).match(/^([0-9]+(?:\.[0-9]+){0,4})(?:\s|　|、|\.|$)/u)?.[1];
}

function blockId(input: { sourceId: string; kind: string; ordinal: number; heading?: string }): string {
  return [input.sourceId, input.kind, input.ordinal, input.heading ?? ""].join(":");
}

export function extractDocumentStructureBlocks(input: { sourceId: string; text: string }): DocumentStructureBlock[] {
  const blocks: DocumentStructureBlock[] = [];
  const lines = input.text.split(/\r?\n/);
  const sectionPath: string[] = [];
  let heading = "";
  let offset = 0;
  let ordinal = 0;
  let tableHeader: string[] | undefined;

  function push(kind: DocumentBlockKind, rawText: string, extra: Partial<DocumentStructureBlock> = {}): void {
    const normalizedText = stripMarkup(rawText);
    if (!normalizedText) {
      return;
    }
    ordinal += 1;
    blocks.push({
      id: blockId({ sourceId: input.sourceId, kind, ordinal, heading }),
      kind,
      sourceId: input.sourceId,
      sectionPath: [...sectionPath],
      heading: heading || undefined,
      rawText,
      normalizedText,
      startOffset: extra.startOffset ?? offset,
      endOffset: extra.endOffset,
      ...extra
    });
  }

  lines.forEach((line) => {
    const lineStart = offset;
    offset += line.length + 1;
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      heading = stripMarkup(headingMatch[2] ?? "");
      const depth = headingMatch[1]?.length ?? 1;
      sectionPath.splice(Math.max(0, depth - 1));
      sectionPath[depth - 1] = heading;
      tableHeader = undefined;
      push("section", line, { startOffset: lineStart, tableNo: tableNoFromText(heading), formulaNo: formulaNoFromText(heading) });
      return;
    }

    if (isMarkdownDivider(line)) {
      return;
    }

    if (line.includes("|")) {
      const cells = splitMarkdownRow(line);
      if (cells.length >= 2) {
        if (!tableHeader) {
          tableHeader = cells;
          push("table", line, {
            cells,
            headers: cells,
            rowIndex: 0,
            tableNo: tableNoFromText(heading) ?? tableNoFromText(line),
            startOffset: lineStart
          });
        } else {
          push("table_row", line, {
            cells,
            headers: tableHeader,
            rowIndex: blocks.filter((block) => block.kind === "table_row" && block.heading === heading).length + 1,
            tableNo: tableNoFromText(heading) ?? tableNoFromText(line),
            startOffset: lineStart
          });
        }
        return;
      }
    } else {
      tableHeader = undefined;
    }

    const clean = stripMarkup(line);
    if (!clean) {
      return;
    }
    const clauseNo = clauseNoFromText(clean);
    const formulaNo = formulaNoFromText(clean);
    if (/(^术语|定义|是指|指\s*)/u.test(clean)) {
      push("definition", line, { clauseNo, startOffset: lineStart });
      return;
    }
    if (formulaNo || (/[=＝]/.test(clean) && /(公式|计算|按式|浓度|平均|指数|限值)/u.test(clean))) {
      push("formula", line, { clauseNo, formulaNo, startOffset: lineStart });
      return;
    }
    if (/^附录/u.test(clean)) {
      push("appendix", line, { startOffset: lineStart });
      return;
    }
    if (/^(注|注：|备注)/u.test(clean)) {
      push("note", line, { startOffset: lineStart });
      return;
    }
    if (clauseNo) {
      push("clause", line, { clauseNo, startOffset: lineStart });
    }
  });

  return blocks;
}
