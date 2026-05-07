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

function splitHtmlTableCells(row: string): string[] {
  return [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/giu)].map((match) => stripMarkup(match[1] ?? "")).filter(Boolean);
}

function htmlRows(line: string): string[] {
  return [...line.matchAll(/<tr[\s\S]*?<\/tr>/giu)].map((match) => match[0]);
}

function repairHeaderCells(cells: string[]): string[] {
  return cells.map((cell, index) => (cell === "级" && cells[index - 1] === "一级" ? "二级" : cell));
}

function isHtmlHeaderContinuation(cells: string[]): boolean {
  if (!cells.length || cells.some((cell) => /[0-9]/.test(cell))) {
    return false;
  }
  return cells.every((cell) =>
    /^(序号|编号|污染物项目|项目|平均时间|评价时段|单位|一级|二级|三级|级|浓度|限值|过渡阶段浓度限值|标准限值)$/u.test(cell)
  );
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
  let htmlTableHeader: string[] | undefined;
  let htmlRowIndex = 0;
  let carriedHtmlRowPrefix: string[] | undefined;

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

    const rows = htmlRows(line);
    if (rows.length) {
      for (const row of rows) {
        const cells = splitHtmlTableCells(row);
        if (cells.length < 2) {
          continue;
        }
        const isHeader = /<th[\s>]/iu.test(row) || !htmlTableHeader;
        if (isHeader) {
          htmlTableHeader = repairHeaderCells(cells);
          htmlRowIndex = 0;
          push("table", row, {
            cells,
            headers: htmlTableHeader,
            rowIndex: 0,
            tableNo: tableNoFromText(heading) ?? tableNoFromText(row),
            startOffset: lineStart
          });
          continue;
        }
        if (isHtmlHeaderContinuation(cells)) {
          const repairedCells = repairHeaderCells(cells);
          htmlTableHeader = [...(htmlTableHeader ?? []), ...repairedCells];
          push("table", row, {
            cells: repairedCells,
            headers: htmlTableHeader,
            rowIndex: 0,
            tableNo: tableNoFromText(heading) ?? tableNoFromText(row),
            startOffset: lineStart
          });
          continue;
        }
        htmlRowIndex += 1;
        const periodCellIndex = cells.findIndex((cell) =>
          /^(年平均|日平均|24小时平均|1小时平均|小时平均|日最大|第[0-9]+百分位)/u.test(cell)
        );
        const prefixCells =
          periodCellIndex > 0
            ? cells
                .slice(0, periodCellIndex)
                .filter((cell) => /[\p{Script=Han}A-Za-z0-9]/u.test(cell) && !/^(序号|污染物项目|编号)$/u.test(cell))
            : [];
        if (prefixCells.length) {
          carriedHtmlRowPrefix = prefixCells;
        }
        const normalizedCells = periodCellIndex === 0 && carriedHtmlRowPrefix?.length ? [...carriedHtmlRowPrefix, ...cells] : cells;
        push("table_row", [...(htmlTableHeader ?? []), ...normalizedCells].join(" "), {
          cells: normalizedCells,
          headers: htmlTableHeader,
          rowIndex: htmlRowIndex,
          tableNo: tableNoFromText(heading) ?? tableNoFromText(row),
          startOffset: lineStart
        });
      }
      return;
    } else {
      htmlTableHeader = undefined;
      htmlRowIndex = 0;
      carriedHtmlRowPrefix = undefined;
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
          push("table_row", [...tableHeader, ...cells].join(" "), {
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
