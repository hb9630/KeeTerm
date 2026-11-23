/* 迷你代码编辑区(CodeMirror 6 core,无语言包=零语法高亮):
   只取滚动流畅的编辑内核 + 撤销重做 + 折行;非受控,doc 变化回调给父。 */
import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";

export default function CodeArea({ value, onChange, onSave }: {
  value: string; onChange: (v: string) => void; onSave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const changeRef = useRef(onChange);
  const saveRef = useRef(onSave);
  useEffect(() => { changeRef.current = onChange; saveRef.current = onSave; });

  useEffect(() => {
    const v = new EditorView({
      doc: value,
      parent: ref.current!,
      extensions: [
        lineNumbers(),
        EditorView.lineWrapping,
        history(),
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => { saveRef.current(); return true; } },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.theme({
          "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent" },
          "&.cm-focused": { outline: "none" },
          ".cm-scroller": { fontFamily: "'Cascadia Mono','JetBrains Mono',Consolas,monospace", lineHeight: "1.65" },
          ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "rgb(0 0 0 / 0.28)" },
          ".cm-content": { padding: "10px 0" },
          ".cm-activeLine": { backgroundColor: "rgb(0 0 0 / 0.03)" },
          ".cm-activeLineGutter": { backgroundColor: "transparent" },
        }, { dark: false }),
        EditorView.updateListener.of(u => { if (u.docChanged) changeRef.current(u.state.doc.toString()); }),
      ],
    });
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={ref} className="h-full w-full overflow-hidden bg-background" />;
}
