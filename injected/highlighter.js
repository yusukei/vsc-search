// Multi-language syntax tokenizer for VS Code search results
// Plain script - sets window.__vscSearchHighlighter
(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Color palette (VS Code Dark+ theme)
  // ---------------------------------------------------------------------------
  var COLOR = {
    keyword:    "#569cd6",
    string:     "#ce9178",
    comment:    "#6a9955",
    number:     "#b5cea8",
    type:       "#4ec9b0",
    identifier: "#9cdcfe",
    operator:   "#d4d4d4",
    attribute:  "#d7ba7d",
    whitespace: null
  };

  // ---------------------------------------------------------------------------
  // Per-language keyword sets
  // ---------------------------------------------------------------------------
  var KEYWORDS = {
    csharp: new Set([
      "abstract", "as", "async", "await", "base", "bool", "break", "byte",
      "case", "catch", "char", "checked", "class", "const", "continue",
      "decimal", "default", "delegate", "do", "double", "else", "enum",
      "event", "explicit", "extern", "false", "finally", "fixed", "float",
      "for", "foreach", "get", "goto", "if", "implicit", "in", "int",
      "interface", "internal", "is", "lock", "long", "namespace", "new",
      "null", "object", "operator", "out", "override", "params", "partial",
      "private", "protected", "public", "readonly", "ref", "return",
      "sbyte", "sealed", "set", "short", "sizeof", "stackalloc", "static",
      "string", "struct", "switch", "this", "throw", "true", "try",
      "typeof", "uint", "ulong", "unchecked", "unsafe", "ushort", "using",
      "value", "var", "virtual", "void", "volatile", "when", "where",
      "while", "yield"
    ]),
    typescript: new Set([
      "abstract", "any", "as", "async", "await", "bigint", "boolean",
      "break", "case", "catch", "class", "const", "constructor", "continue",
      "debugger", "declare", "default", "delete", "do", "else", "enum",
      "export", "extends", "false", "finally", "for", "from", "function",
      "get", "if", "implements", "import", "in", "infer", "instanceof",
      "interface", "is", "keyof", "let", "module", "namespace", "never",
      "new", "null", "number", "of", "override", "package", "private",
      "protected", "public", "readonly", "require", "return", "set",
      "static", "string", "super", "switch", "symbol", "this", "throw",
      "true", "try", "type", "typeof", "undefined", "unique", "unknown",
      "var", "void", "while", "with", "yield"
    ]),
    javascript: new Set([
      "async", "await", "break", "case", "catch", "class", "const",
      "constructor", "continue", "debugger", "default", "delete", "do",
      "else", "export", "extends", "false", "finally", "for", "from",
      "function", "get", "if", "import", "in", "instanceof", "let", "new",
      "null", "of", "return", "set", "static", "super", "switch", "this",
      "throw", "true", "try", "typeof", "undefined", "var", "void",
      "while", "with", "yield"
    ]),
    python: new Set([
      "False", "None", "True", "and", "as", "assert", "async", "await",
      "break", "class", "continue", "def", "del", "elif", "else", "except",
      "finally", "for", "from", "global", "if", "import", "in", "is",
      "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try",
      "while", "with", "yield"
    ]),
    java: new Set([
      "abstract", "assert", "boolean", "break", "byte", "case", "catch",
      "char", "class", "const", "continue", "default", "do", "double",
      "else", "enum", "extends", "false", "final", "finally", "float",
      "for", "goto", "if", "implements", "import", "instanceof", "int",
      "interface", "long", "native", "new", "null", "package", "private",
      "protected", "public", "return", "short", "static", "strictfp",
      "super", "switch", "synchronized", "this", "throw", "throws",
      "transient", "true", "try", "var", "void", "volatile", "while"
    ]),
    go: new Set([
      "break", "case", "chan", "const", "continue", "default", "defer",
      "else", "fallthrough", "false", "for", "func", "go", "goto", "if",
      "import", "interface", "iota", "map", "nil", "package", "range",
      "return", "select", "struct", "switch", "true", "type", "var"
    ]),
    rust: new Set([
      "Self", "as", "async", "await", "break", "const", "continue",
      "crate", "dyn", "else", "enum", "extern", "false", "fn", "for",
      "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut",
      "pub", "ref", "return", "self", "static", "struct", "super", "trait",
      "true", "type", "unsafe", "use", "where", "while"
    ])
  };

  // Alias common language IDs
  KEYWORDS.typescriptreact = KEYWORDS.typescript;
  KEYWORDS.javascriptreact = KEYWORDS.javascript;
  KEYWORDS.cs = KEYWORDS.csharp;
  KEYWORDS.ts = KEYWORDS.typescript;
  KEYWORDS.js = KEYWORDS.javascript;
  KEYWORDS.py = KEYWORDS.python;
  KEYWORDS.rs = KEYWORDS.rust;
  KEYWORDS.golang = KEYWORDS.go;

  // Default keyword set (union of very common keywords across languages)
  KEYWORDS._default = new Set([
    "abstract", "as", "async", "await", "bool", "boolean", "break", "byte",
    "case", "catch", "char", "class", "const", "continue", "debugger",
    "default", "delete", "do", "double", "else", "enum", "export",
    "extends", "false", "final", "finally", "float", "for", "from",
    "function", "get", "goto", "if", "implements", "import", "in",
    "instanceof", "int", "interface", "is", "let", "long", "namespace",
    "new", "null", "of", "override", "package", "private", "protected",
    "public", "readonly", "return", "set", "short", "static", "string",
    "struct", "super", "switch", "this", "throw", "throws", "true", "try",
    "type", "typeof", "undefined", "using", "var", "virtual", "void",
    "volatile", "while", "with", "yield"
  ]);

  // Languages that use # for line comments instead of //
  var HASH_COMMENT_LANGS = new Set(["python", "py", "ruby", "rb", "perl", "pl", "bash", "sh", "shellscript", "yaml", "yml"]);

  // Languages that support backtick template strings
  var BACKTICK_LANGS = new Set(["javascript", "js", "javascriptreact", "typescript", "ts", "typescriptreact", "go", "golang"]);

  // Languages where [...] should be highlighted as attributes/decorators
  var BRACKET_ATTR_LANGS = new Set(["csharp", "cs"]);

  // ---------------------------------------------------------------------------
  // Tokenizer
  // ---------------------------------------------------------------------------
  function getKeywords(languageId) {
    if (!languageId) { return KEYWORDS._default; }
    var id = languageId.toLowerCase();
    return KEYWORDS[id] || KEYWORDS._default;
  }

  function tokenize(line, languageId) {
    var tokens = [];
    var i = 0;
    var len = line.length;
    var langId = (languageId || "").toLowerCase();
    var kw = getKeywords(languageId);
    var usesHashComment = HASH_COMMENT_LANGS.has(langId);
    var usesBacktick = BACKTICK_LANGS.has(langId);
    var usesBracketAttr = BRACKET_ATTR_LANGS.has(langId);

    while (i < len) {
      var ch = line[i];

      // -- Whitespace --
      if (ch === " " || ch === "\t") {
        var ws = "";
        while (i < len && (line[i] === " " || line[i] === "\t")) {
          ws += line[i];
          i++;
        }
        tokens.push({ text: ws, color: COLOR.whitespace });
        continue;
      }

      // -- Line comments: // --
      if (ch === "/" && i + 1 < len && line[i + 1] === "/") {
        tokens.push({ text: line.slice(i), color: COLOR.comment });
        i = len;
        continue;
      }

      // -- Hash comments: # (Python, Ruby, etc.) --
      if (ch === "#" && usesHashComment) {
        tokens.push({ text: line.slice(i), color: COLOR.comment });
        i = len;
        continue;
      }

      // -- Double-quoted string --
      if (ch === '"') {
        var dq = '"';
        i++;
        while (i < len && line[i] !== '"') {
          if (line[i] === "\\" && i + 1 < len) {
            dq += line[i] + line[i + 1];
            i += 2;
          } else {
            dq += line[i];
            i++;
          }
        }
        if (i < len) { dq += '"'; i++; }
        tokens.push({ text: dq, color: COLOR.string });
        continue;
      }

      // -- Single-quoted string --
      if (ch === "'") {
        var sq = "'";
        i++;
        while (i < len && line[i] !== "'") {
          if (line[i] === "\\" && i + 1 < len) {
            sq += line[i] + line[i + 1];
            i += 2;
          } else {
            sq += line[i];
            i++;
          }
        }
        if (i < len) { sq += "'"; i++; }
        tokens.push({ text: sq, color: COLOR.string });
        continue;
      }

      // -- Backtick template string --
      if (ch === "`" && usesBacktick) {
        var bt = "`";
        i++;
        while (i < len && line[i] !== "`") {
          if (line[i] === "\\" && i + 1 < len) {
            bt += line[i] + line[i + 1];
            i += 2;
          } else {
            bt += line[i];
            i++;
          }
        }
        if (i < len) { bt += "`"; i++; }
        tokens.push({ text: bt, color: COLOR.string });
        continue;
      }

      // -- Decorators / Attributes: @identifier --
      if (ch === "@") {
        var dec = "@";
        i++;
        while (i < len && /[a-zA-Z0-9_.]/.test(line[i])) {
          dec += line[i];
          i++;
        }
        tokens.push({ text: dec, color: COLOR.attribute });
        continue;
      }

      // -- C# bracket attributes: [...] --
      if ((ch === "[" || ch === "]") && usesBracketAttr) {
        tokens.push({ text: ch, color: COLOR.attribute });
        i++;
        continue;
      }

      // -- Numbers --
      if (ch >= "0" && ch <= "9") {
        var num = "";
        // Hex prefix
        if (ch === "0" && i + 1 < len && (line[i + 1] === "x" || line[i + 1] === "X")) {
          num = "0" + line[i + 1];
          i += 2;
          while (i < len && /[0-9a-fA-F_]/.test(line[i])) { num += line[i]; i++; }
        } else {
          while (i < len && /[0-9._eE]/.test(line[i])) {
            num += line[i];
            i++;
            // Handle exponent sign: e+ or e-
            if ((line[i - 1] === "e" || line[i - 1] === "E") && i < len && (line[i] === "+" || line[i] === "-")) {
              num += line[i];
              i++;
            }
          }
        }
        // Consume numeric suffixes (f32, u64, i128, etc.)
        while (i < len && /[fFdDlLuUnNiI0-9]/.test(line[i])) { num += line[i]; i++; }
        tokens.push({ text: num, color: COLOR.number });
        continue;
      }

      // -- Identifiers and keywords --
      if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_") {
        var word = "";
        while (i < len && ((line[i] >= "a" && line[i] <= "z") || (line[i] >= "A" && line[i] <= "Z") || (line[i] >= "0" && line[i] <= "9") || line[i] === "_")) {
          word += line[i];
          i++;
        }
        if (kw.has(word)) {
          tokens.push({ text: word, color: COLOR.keyword });
        } else if (word[0] >= "A" && word[0] <= "Z") {
          tokens.push({ text: word, color: COLOR.type });
        } else {
          tokens.push({ text: word, color: COLOR.identifier });
        }
        continue;
      }

      // -- Operators and punctuation --
      if (/[{}();,.<>?:=+\-*\/&|!~^%\[\]\\]/.test(ch)) {
        var op = ch;
        i++;
        // Consume common two-character operators
        if (i < len && /[=>&|+\-<>?:.]/.test(line[i])) {
          var pair = op + line[i];
          // Recognized two-char operators
          if (pair === "==" || pair === "!=" || pair === "<=" || pair === ">=" ||
              pair === "&&" || pair === "||" || pair === "++" || pair === "--" ||
              pair === "+=" || pair === "-=" || pair === "*=" || pair === "/=" ||
              pair === "=>" || pair === "->" || pair === "::" || pair === "<<" ||
              pair === ">>" || pair === "??" || pair === "?." || pair === "..") {
            op = pair;
            i++;
            // Three-char: ===, !==, >>>, <<=, >>=, ..., ??=
            if (i < len) {
              var triple = op + line[i];
              if (triple === "===" || triple === "!==" || triple === ">>>" ||
                  triple === "<<=" || triple === ">>=" || triple === "..." ||
                  triple === "??=") {
                op = triple;
                i++;
              }
            }
          }
        }
        tokens.push({ text: op, color: COLOR.operator });
        continue;
      }

      // -- Anything else: emit as-is with default identifier color --
      tokens.push({ text: ch, color: COLOR.identifier });
      i++;
    }

    return tokens;
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------
  window.__vscSearchHighlighter = {
    tokenize: tokenize
  };
})();
