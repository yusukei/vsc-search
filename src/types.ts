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
}

export interface FileContentResponse {
  content: string;
  languageId: string;
}
