// Rundmail – Datei-Download und Druck-als-PDF Helper.

export function downloadFile(name: string, content: string, mime = "text/plain;charset=utf-8") {
  const blob = new Blob(["\uFEFF", content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function printHtmlAsPdf(html: string): void {
  const w = window.open("", "_blank", "width=1200,height=900");
  if (!w) { alert("Popup blockiert – bitte für diese Seite erlauben."); return; }
  w.document.write(html);
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 450);
}

export async function copyHtmlToClipboard(html: string): Promise<void> {
  if (typeof navigator?.clipboard?.write === "function") {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([html.replace(/<[^>]+>/g, " ")], { type: "text/plain" }),
      }),
    ]);
  } else {
    // Fallback: neuen Tab \u00F6ffnen, User kann dort manuell kopieren
    const blob = new Blob(["\uFEFF", html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    throw new Error("clipboard-fallback");
  }
}

