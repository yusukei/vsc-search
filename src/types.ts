export interface SearchParams {
  query: string;
  directory: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
}

export interface SearchResult {
  filePath: string;
  fileName: string;
  lineNumber: number;
  lineContent: string;
  column: number;
}

export interface SearchResponse {
  results: SearchResult[];
  fileCount: number;
  totalHits: number;
  searchTimeMs: number;
  truncated: boolean;
}

export interface FileContentResponse {
  content: string;
  languageId: string;
}

// --- Worker Thread message types ---

export interface WorkerSearchRequest {
  type: "search";
  searchId: number;
  filePaths: string[];
  relativePaths: string[];
  params: SearchParams;
}

export interface WorkerAbortRequest {
  type: "abort";
  searchId: number;
}

export type MainToWorkerMessage = WorkerSearchRequest | WorkerAbortRequest;

export interface WorkerSearchResult {
  type: "result";
  searchId: number;
  results: SearchResult[];
  fileCount: number;
  totalHits: number;
  truncated: boolean;
}

export interface WorkerSearchAborted {
  type: "aborted";
  searchId: number;
}

export interface WorkerSearchError {
  type: "error";
  searchId: number;
  message: string;
}

export type WorkerToMainMessage =
  | WorkerSearchResult
  | WorkerSearchAborted
  | WorkerSearchError;
