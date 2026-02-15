import { useState, useEffect, useRef, useCallback } from "react";

const MOCK_FILES = {
  "Assets/ILCA/Scripts/Manager/ModelManager.cs": `using UnityEngine;
using System.Collections.Generic;

namespace ILCA.Scripts.Manager
{
    public class ModelManager : MonoBehaviour
    {
        [SerializeField] private List<GameObject> models;
        [SerializeField] private int currentIndex = 0;

        private static ModelManager _instance;
        public static ModelManager Instance => _instance;

        private void Awake()
        {
            if (_instance != null && _instance != this)
            {
                Destroy(gameObject);
                return;
            }
            _instance = this;
        }

        public void ChangeBodyColor(int index)
        {
            ServerRpc.Instance.ChangeBodyColorRpc(index);
        }

        public void ChangeDoorColor(int index)
        {
            ServerRpc.Instance.ChangeDoorColorRpc(index);
        }

        public void ToggleDoorState()
        {
            ServerRpc.Instance.ToggleDoorStateRpc();
        }

        public void ToggleDecal1()
        {
            if (models[currentIndex] != null)
            {
                var decal = models[currentIndex].GetComponent<DecalToggle>();
                decal?.ToggleDecal(0);
            }
        }

        public void ToggleDecal2()
        {
            if (models[currentIndex] != null)
            {
                var decal = models[currentIndex].GetComponent<DecalToggle>();
                decal?.ToggleDecal(1);
            }
        }
    }
}`,
  "Assets/ILCA/Scripts/Debug/DebugModel.cs": `using UnityEngine;
using UnityEngine.UI;

namespace ILCA.Scripts.Debug
{
    public class DebugModel : MonoBehaviour
    {
        [SerializeField] private Button toggleDoorBtn;
        [SerializeField] private Button toggleDecal1Btn;
        [SerializeField] private Button toggleDecal2Btn;

        [ButtonField(nameof(ToggleDecal1))] [SerializeField]
        private bool _toggleDecal1Debug;

        [ButtonField(nameof(ToggleDecal2))] [SerializeField]
        private bool _toggleDecal2Debug;

        private void Start()
        {
            toggleDoorBtn?.onClick.AddListener(ToggleDoorState);
            toggleDecal1Btn?.onClick.AddListener(ToggleDecal1);
            toggleDecal2Btn?.onClick.AddListener(ToggleDecal2);
        }

        public void ToggleDecal1()
        {
            Debug.Log("[DebugModel] ToggleDecal1 called");
            ModelManager.Instance?.ToggleDecal1();
        }

        public void ToggleDecal2()
        {
            Debug.Log("[DebugModel] ToggleDecal2 called");
            ModelManager.Instance?.ToggleDecal2();
        }

        public void ToggleDoorState()
        {
            Debug.Log("[DebugModel] ToggleDoorState called");
            ModelManager.Instance?.ToggleDoorState();
        }
    }
}`,
  "Assets/ILCA/Scripts/UI/MenuToggleController.cs": `using UnityEngine;
using UnityEngine.UI;

namespace ILCA.Scripts.UI
{
    public class MenuToggleController : MonoBehaviour
    {
        [SerializeField] private Toggle doorToggle;
        [SerializeField] private Toggle decal1Toggle;
        [SerializeField] private Toggle decal2Toggle;

        private void Start()
        {
            doorToggle?.onValueChanged.AddListener(OnDoorToggleChanged);
            decal1Toggle?.onValueChanged.AddListener(OnDecal1ToggleChanged);
            decal2Toggle?.onValueChanged.AddListener(OnDecal2ToggleChanged);
        }

        private void OnDoorToggleChanged(bool isOn)
        {
            ModelManager.Instance?.ToggleDoorState();
        }

        private void OnDecal1ToggleChanged(bool isOn)
        {
            ModelManager.Instance?.ToggleDecal1();
        }

        private void OnDecal2ToggleChanged(bool isOn)
        {
            ModelManager.Instance?.ToggleDecal2();
        }
    }
}`,
  "Assets/ILCA/Scripts/Network/ServerRpc.cs": `using Unity.Netcode;

namespace ILCA.Scripts.Network
{
    public class ServerRpc : NetworkBehaviour
    {
        private static ServerRpc _instance;
        public static ServerRpc Instance => _instance;

        private void Awake()
        {
            _instance = this;
        }

        [ServerRpc(RequireOwnership = false)]
        public void ToggleDoorStateRpc()
        {
            ToggleDoorStateClientRpc();
        }

        [ClientRpc]
        private void ToggleDoorStateClientRpc()
        {
            // Apply door state toggle to all clients
        }

        [ServerRpc(RequireOwnership = false)]
        public void ChangeBodyColorRpc(int index)
        {
            ChangeBodyColorClientRpc(index);
        }

        [ClientRpc]
        private void ChangeBodyColorClientRpc(int index)
        {
            // Apply body color change to all clients
        }

        [ServerRpc(RequireOwnership = false)]
        public void ChangeDoorColorRpc(int index)
        {
            ChangeDoorColorClientRpc(index);
        }

        [ClientRpc]
        private void ChangeDoorColorClientRpc(int index)
        {
            // Apply door color change to all clients
        }
    }
}`,
  "Assets/ILCA/Scripts/Variables/Variables.cs": `using UnityEngine;

namespace ILCA.Scripts.Variables
{
    public class Variables : MonoBehaviour
    {
        [SerializeField] private string modelName;
        [SerializeField] private bool isDoorOpen;
        [SerializeField] private int bodyColorIndex;

        private void OnValidate()
        {
            if (string.IsNullOrEmpty(modelName))
            {
                Debug.LogWarning("[Variables] No Model found in scene for ToggleDoorState");
            }
        }

        public bool ToggleDoor()
        {
            isDoorOpen = !isDoorOpen;
            return isDoorOpen;
        }
    }
}`,
};

function getFileName(path) {
  return path.split("/").pop();
}

function searchFiles(query, caseSensitive, wholeWord, useRegex) {
  if (!query || query.length < 1) return [];
  const results = [];
  let pattern;
  try {
    if (useRegex) {
      pattern = new RegExp(query, caseSensitive ? "g" : "gi");
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const expr = wholeWord ? `\\b${escaped}\\b` : escaped;
      pattern = new RegExp(expr, caseSensitive ? "g" : "gi");
    }
  } catch {
    return [];
  }
  for (const [filePath, content] of Object.entries(MOCK_FILES)) {
    const lines = content.split("\n");
    lines.forEach((line, idx) => {
      if (pattern.test(line)) {
        results.push({ filePath, fileName: getFileName(filePath), lineNumber: idx + 1, lineContent: line });
        pattern.lastIndex = 0;
      }
    });
  }
  return results;
}

function splitHighlight(text, query, caseSensitive, wholeWord, useRegex) {
  if (!query) return [{ t: text, h: false }];
  let pattern;
  try {
    if (useRegex) {
      pattern = new RegExp(`(${query})`, caseSensitive ? "g" : "gi");
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const expr = wholeWord ? `\\b(${escaped})\\b` : `(${escaped})`;
      pattern = new RegExp(expr, caseSensitive ? "g" : "gi");
    }
  } catch {
    return [{ t: text, h: false }];
  }
  const parts = text.split(pattern);
  return parts
    .filter((p) => p !== "")
    .map((p) => ({ t: p, h: pattern.test(p) ? true : false }))
    .map((p) => {
      pattern.lastIndex = 0;
      return { t: p.t, h: pattern.test(p.t) };
    });
}

const KW = new Set([
  "using","namespace","public","private","protected","static","void","class","int","bool",
  "string","new","return","if","else","var","get","set","override","virtual","this","null",
  "true","false","readonly","const","sealed","abstract","partial","async","await","private",
]);

function tokenize(line) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === " " || line[i] === "\t") {
      let ws = "";
      while (i < line.length && (line[i] === " " || line[i] === "\t")) { ws += line[i]; i++; }
      tokens.push({ t: ws, c: "ws" });
    } else if (line.startsWith("//", i)) {
      tokens.push({ t: line.slice(i), c: "cmt" });
      i = line.length;
    } else if (line[i] === '"') {
      let s = '"'; i++;
      while (i < line.length && line[i] !== '"') { s += line[i]; i++; }
      if (i < line.length) { s += '"'; i++; }
      tokens.push({ t: s, c: "str" });
    } else if (line[i] === "[" || line[i] === "]") {
      tokens.push({ t: line[i], c: "attr" });
      i++;
    } else if (/[{}();,.<>?:=+\-*\/&|!~^%]/.test(line[i])) {
      let op = line[i]; i++;
      if (i < line.length && /[=>&|+\-]/.test(line[i])) { op += line[i]; i++; }
      tokens.push({ t: op, c: "op" });
    } else if (/[a-zA-Z_]/.test(line[i])) {
      let w = "";
      while (i < line.length && /[a-zA-Z0-9_]/.test(line[i])) { w += line[i]; i++; }
      tokens.push({ t: w, c: KW.has(w) ? "kw" : "id" });
    } else if (/[0-9]/.test(line[i])) {
      let n = "";
      while (i < line.length && /[0-9.xXa-fA-F]/.test(line[i])) { n += line[i]; i++; }
      tokens.push({ t: n, c: "num" });
    } else {
      tokens.push({ t: line[i], c: "id" });
      i++;
    }
  }
  return tokens;
}

const TC = {
  kw: "#569cd6", str: "#ce9178", cmt: "#6a9955", num: "#b5cea8",
  attr: "#d7ba7d", op: "#d4d4d4", id: "#9cdcfe", ws: "transparent",
};

function SyntaxLine({ text }) {
  const toks = tokenize(text);
  return (
    <>
      {toks.map((tk, i) => (
        <span key={i} style={{ color: TC[tk.c] || "#d4d4d4" }}>{tk.t}</span>
      ))}
    </>
  );
}

const Tog = ({ label, active, onClick, title }) => (
  <button
    onClick={onClick}
    title={title}
    style={{
      background: active ? "rgba(255,255,255,0.12)" : "transparent",
      border: active ? "1px solid rgba(255,255,255,0.25)" : "1px solid transparent",
      color: active ? "#e0e0e0" : "#707070",
      borderRadius: 3, padding: "1px 5px", cursor: "pointer",
      fontSize: 12, fontFamily: "monospace", lineHeight: "20px", minWidth: 24, textAlign: "center",
    }}
  >
    {label}
  </button>
);

export default function VSCSearchMock() {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("Toggle");
  const [dir, setDir] = useState("Assets/ILCA/Scripts");
  const [cc, setCc] = useState(false);
  const [ww, setWw] = useState(false);
  const [rx, setRx] = useState(false);
  const [results, setResults] = useState([]);
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const previewRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => {
      const r = searchFiles(query, cc, ww, rx);
      setResults(r);
      setSel(0);
    }, 200);
    return () => clearTimeout(t);
  }, [query, cc, ww, rx]);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  useEffect(() => {
    if (previewRef.current && results[sel]) {
      const el = previewRef.current.querySelector(`[data-ln="${results[sel].lineNumber}"]`);
      if (el) el.scrollIntoView({ block: "center", behavior: "auto" });
    }
    if (listRef.current) {
      const active = listRef.current.querySelector(`[data-ri="${sel}"]`);
      if (active) active.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }, [sel, results]);

  const onKey = useCallback(
    (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((p) => Math.min(p + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((p) => Math.max(p - 1, 0));
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    },
    [results]
  );

  const cur = results[sel] || null;
  const fileCount = new Set(results.map((r) => r.filePath)).size;
  const curLines = cur ? (MOCK_FILES[cur.filePath] || "").split("\n") : [];

  const PREVIEW_CTX = 8;
  let previewStart = 0;
  let previewEnd = curLines.length;
  if (cur) {
    previewStart = Math.max(0, cur.lineNumber - 1 - PREVIEW_CTX);
    previewEnd = Math.min(curLines.length, cur.lineNumber + PREVIEW_CTX);
  }
  const previewLines = curLines.slice(previewStart, previewEnd);

  if (!open)
    return (
      <div style={{ height: "100vh", width: "100%", background: "#1e1e1e", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <button
          onClick={() => setOpen(true)}
          style={{
            background: "#007acc", color: "#fff", border: "none", borderRadius: 6,
            padding: "10px 24px", fontSize: 14, cursor: "pointer", fontFamily: "system-ui",
          }}
        >
          vsc-search を開く (Ctrl+Shift+F)
        </button>
      </div>
    );

  return (
    <div style={{ height: "100vh", width: "100%", background: "#1e1e1e", position: "relative", overflow: "hidden" }}>
      {/* Background: fake VS Code editor */}
      <div style={{ opacity: 0.25, padding: "40px 60px", fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace", fontSize: 13, lineHeight: "20px", color: "#d4d4d4" }}>
        {MOCK_FILES["Assets/ILCA/Scripts/Manager/ModelManager.cs"].split("\n").slice(0, 35).map((l, i) => (
          <div key={i} style={{ display: "flex" }}>
            <span style={{ width: 40, textAlign: "right", marginRight: 16, color: "#5a5a5a", userSelect: "none" }}>{i + 1}</span>
            <SyntaxLine text={l} />
          </div>
        ))}
      </div>

      {/* Overlay backdrop */}
      <div
        onClick={() => setOpen(false)}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 9998 }}
      />

      {/* Floating Modal */}
      <div
        style={{
          position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
          width: "min(780px, 90vw)", maxHeight: "80vh",
          background: "#252526", border: "1px solid #454545", borderRadius: 8,
          boxShadow: "0 16px 48px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)",
          zIndex: 9999, display: "flex", flexDirection: "column", overflow: "hidden",
        }}
      >
        {/* Header / Search bar */}
        <div style={{ padding: "12px 14px 8px", borderBottom: "1px solid #3c3c3c" }}>
          {/* Search row */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <span style={{ color: "#858585", fontSize: 14, flexShrink: 0 }}>🔍</span>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
              placeholder="検索..."
              spellCheck={false}
              style={{
                flex: 1, background: "#3c3c3c", border: "1px solid #3c3c3c", color: "#e0e0e0",
                padding: "5px 10px", borderRadius: 4, fontSize: 13, outline: "none",
                fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
              }}
              onFocus={(e) => (e.target.style.borderColor = "#007acc")}
              onBlur={(e) => (e.target.style.borderColor = "#3c3c3c")}
            />
            <Tog label="Cc" active={cc} onClick={() => setCc(!cc)} title="大文字/小文字を区別" />
            <Tog label="W" active={ww} onClick={() => setWw(!ww)} title="単語単位でマッチ" />
            <Tog label=".*" active={rx} onClick={() => setRx(!rx)} title="正規表現を使用" />
          </div>

          {/* Directory row */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "#858585", fontSize: 13, flexShrink: 0 }}>📁</span>
            <input
              type="text"
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              placeholder="ディレクトリ..."
              spellCheck={false}
              style={{
                flex: 1, background: "#3c3c3c", border: "1px solid #3c3c3c", color: "#b0b0b0",
                padding: "4px 10px", borderRadius: 4, fontSize: 12, outline: "none",
                fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
              }}
            />
            {results.length > 0 && (
              <span style={{ fontSize: 11, color: "#858585", whiteSpace: "nowrap", flexShrink: 0 }}>
                {results.length}件 / {fileCount}ファイル
              </span>
            )}
          </div>
        </div>

        {/* Results list */}
        <div
          ref={listRef}
          style={{
            maxHeight: 220, overflowY: "auto", overflowX: "hidden", borderBottom: "1px solid #3c3c3c",
            scrollbarWidth: "thin", scrollbarColor: "#555 #2a2a2a",
          }}
        >
          {results.length === 0 && query && (
            <div style={{ padding: "16px 20px", color: "#707070", fontSize: 13, textAlign: "center" }}>
              一致する結果がありません
            </div>
          )}
          {results.map((r, i) => {
            const parts = splitHighlight(r.lineContent.trim(), query, cc, ww, rx);
            const active = i === sel;
            return (
              <div
                key={`${r.filePath}-${r.lineNumber}`}
                data-ri={i}
                onClick={() => setSel(i)}
                onDoubleClick={() => setOpen(false)}
                style={{
                  display: "flex", alignItems: "baseline", justifyContent: "space-between",
                  padding: "4px 14px", cursor: "pointer", gap: 16,
                  background: active ? "#04395e" : "transparent",
                }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "#2a2d2e"; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
              >
                <div style={{
                  fontSize: 12.5, fontFamily: "'Cascadia Code','Fira Code',Consolas,monospace",
                  color: "#cccccc", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1,
                }}>
                  {parts.map((p, j) => (
                    <span
                      key={j}
                      style={{
                        background: p.h ? "rgba(234,170,60,0.28)" : "transparent",
                        color: p.h ? "#f0c050" : "#cccccc",
                        borderRadius: p.h ? 2 : 0,
                        padding: p.h ? "0 1px" : 0,
                      }}
                    >
                      {p.t}
                    </span>
                  ))}
                </div>
                <div style={{
                  fontSize: 11, color: active ? "#8ab4d4" : "#707070", whiteSpace: "nowrap", flexShrink: 0,
                  fontFamily: "'Cascadia Code','Fira Code',Consolas,monospace",
                }}>
                  {r.fileName}:{r.lineNumber}
                </div>
              </div>
            );
          })}
        </div>

        {/* Preview / inline editor */}
        {cur && (
          <div style={{ position: "relative" }}>
            {/* File path bar */}
            <div style={{
              padding: "5px 14px", fontSize: 11, color: "#858585", background: "#1e1e1e",
              borderBottom: "1px solid #333",
              fontFamily: "'Cascadia Code','Fira Code',Consolas,monospace",
            }}>
              {cur.filePath}
            </div>
            <div
              ref={previewRef}
              style={{
                maxHeight: 260, overflowY: "auto", overflowX: "auto", background: "#1e1e1e",
                scrollbarWidth: "thin", scrollbarColor: "#555 #1e1e1e",
              }}
            >
              {previewLines.map((line, i) => {
                const ln = previewStart + i + 1;
                const isMatch = ln === cur.lineNumber;
                const matchParts = isMatch ? splitHighlight(line, query, cc, ww, rx) : null;
                return (
                  <div
                    key={ln}
                    data-ln={ln}
                    style={{
                      display: "flex", lineHeight: "20px", minWidth: "fit-content",
                      background: isMatch ? "rgba(255,200,0,0.07)" : "transparent",
                    }}
                  >
                    <div style={{
                      width: 44, textAlign: "right", paddingRight: 14,
                      color: isMatch ? "#e0e0e0" : "#5a5a5a",
                      fontSize: 12.5, fontFamily: "'Cascadia Code','Fira Code',Consolas,monospace",
                      userSelect: "none", flexShrink: 0,
                      background: isMatch ? "rgba(255,200,0,0.04)" : "transparent",
                      borderRight: isMatch ? "2px solid #ffcc00" : "2px solid transparent",
                    }}>
                      {ln}
                    </div>
                    <pre style={{
                      margin: 0, paddingLeft: 10, fontSize: 12.5,
                      fontFamily: "'Cascadia Code','Fira Code',Consolas,monospace",
                      whiteSpace: "pre",
                    }}>
                      {isMatch && matchParts
                        ? matchParts.map((p, j) =>
                            p.h ? (
                              <span key={j} style={{
                                background: "rgba(234,170,60,0.3)", color: "#f0c050",
                                borderRadius: 2, outline: "1px solid rgba(240,192,80,0.5)",
                              }}>
                                {p.t}
                              </span>
                            ) : (
                              <SyntaxLine key={j} text={p.t} />
                            )
                          )
                        : <SyntaxLine text={line} />}
                    </pre>
                  </div>
                );
              })}
            </div>

            {/* Bottom bar */}
            <div style={{
              padding: "4px 14px", display: "flex", justifyContent: "space-between", alignItems: "center",
              background: "#252526", borderTop: "1px solid #3c3c3c", fontSize: 11, color: "#707070",
            }}>
              <span>↑↓ 移動　Enter 開く　Esc 閉じる</span>
              <span>ダブルクリックでエディタに展開</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
