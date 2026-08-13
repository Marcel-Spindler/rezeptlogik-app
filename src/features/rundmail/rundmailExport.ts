// Rundmail – Druck-als-PDF Helper.

export function printHtmlAsPdf(html: string): void {
  const w = window.open("", "_blank", "width=1300,height=920");
  if (!w) { alert("Popup blockiert – bitte für diese Seite erlauben."); return; }

  // Toolbar wird vor window.print() per onclick versteckt, damit sie nicht im PDF landet.
  const toolbar = `<div id="_pdf_bar" style="
      position:fixed;top:0;left:0;right:0;z-index:99999;
      background:#0f172a;padding:9px 16px;
      display:flex;align-items:center;gap:10px;
      box-shadow:0 2px 10px rgba(0,0,0,.5);font-family:sans-serif;">
    <span style="flex:1;font-size:11px;color:#94a3b8;">
      Im Druckdialog als Ziel <strong style="color:#7dd3fc;">»Als PDF speichern«</strong> wählen
    </span>
    <button
      onclick="document.getElementById('_pdf_bar').style.display='none';window.print();"
      style="background:#0ea5e9;color:#fff;border:none;border-radius:6px;
             padding:8px 20px;font-size:13px;font-weight:800;cursor:pointer;">
      💾 Als PDF speichern
    </button>
    <button
      onclick="window.close()"
      style="background:#334155;color:#cbd5e1;border:none;border-radius:6px;
             padding:8px 12px;font-size:12px;cursor:pointer;">
      ✕ Schließen
    </button>
  </div>
  <div style="height:52px;"></div>`;

  const withToolbar = html.replace(/<body([^>]*)>/i, `<body$1>${toolbar}`);
  w.document.write(withToolbar);
  w.document.close();
  w.focus();
}
