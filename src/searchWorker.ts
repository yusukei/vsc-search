import { parentPort } from "worker_threads";
import * as fs from "fs/promises";
import * as path from "path";
import type {
  MainToWorkerMessage,
  WorkerSearchRequest,
  SearchParams,
  SearchResult,
} from "./types";

const BATCH_SIZE = 50;
const MAX_RESULTS = 1000;

let currentSearchId = -1;

parentPort!.on("message", (msg: MainToWorkerMessage) => {
  switch (msg.type) {
    case "search":
      currentSearchId = msg.searchId;
      runSearch(msg);
      break;
    case "abort":
      // currentSearchId check handles this
      break;
  }
});

async function runSearch(req: WorkerSearchRequest): Promise<void> {
  const { searchId, filePaths, relativePaths, params } = req;

  const regex = buildRegex(params);
  if (!regex) {
    parentPort!.postMessage({
      type: "result",
      searchId,
      results: [],
      fileCount: 0,
      totalHits: 0,
      truncated: false,
    });
    return;
  }

  const results: SearchResult[] = [];
  const matchingFiles = new Set<string>();
  let truncated = false;

  for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
    if (currentSearchId !== searchId) {
      parentPort!.postMessage({ type: "aborted", searchId });
      return;
    }

    if (truncated) break;

    const batchEnd = Math.min(i + BATCH_SIZE, filePaths.length);
    const batchPromises: Promise<void>[] = [];

    for (let j = i; j < batchEnd; j++) {
      batchPromises.push(
        processFile(
          filePaths[j],
          relativePaths[j],
          regex,
          results,
          matchingFiles
        )
      );
    }

    await Promise.all(batchPromises);

    if (results.length >= MAX_RESULTS) {
      truncated = true;
    }
  }

  if (currentSearchId !== searchId) {
    parentPort!.postMessage({ type: "aborted", searchId });
    return;
  }

  const finalResults = truncated ? results.slice(0, MAX_RESULTS) : results;

  finalResults.sort(
    (a, b) =>
      a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber
  );

  parentPort!.postMessage({
    type: "result",
    searchId,
    results: finalResults,
    fileCount: matchingFiles.size,
    totalHits: results.length,
    truncated,
  });
}

async function processFile(
  absolutePath: string,
  relativePath: string,
  regex: RegExp,
  results: SearchResult[],
  matchingFiles: Set<string>
): Promise<void> {
  try {
    const content = await fs.readFile(absolutePath, "utf-8");
    if (content.includes("\0")) return;

    const fileName = path.basename(absolutePath);
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      regex.lastIndex = 0;
      const match = regex.exec(line);
      if (match) {
        matchingFiles.add(relativePath);
        results.push({
          filePath: relativePath,
          fileName,
          lineNumber: i + 1,
          lineContent: line,
          column: match.index,
        });
      }
    }
  } catch {
    // skip unreadable files
  }
}

function buildRegex(params: SearchParams): RegExp | null {
  try {
    let pattern: string;
    if (params.useRegex) {
      pattern = params.query;
    } else {
      pattern = params.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    if (params.wholeWord) {
      pattern = `\\b${pattern}\\b`;
    }
    const flags = params.caseSensitive ? "" : "i";
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}
