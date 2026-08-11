// Rundmail – Druck-als-PDF Helper.

export function printHtmlAsPdf(html: string): void {
  // Popup-Breite nahe an der tatsächlichen A4-Querformat-Druckbreite halten,
  // damit die Vorschau vor dem Speichern nicht breiter wirkt als das gespeicherte PDF.
  const w = window.open("", "_blank", "width=1300,height=920");
  if (!w) { alert("Popup blockiert – bitte für diese Seite erlauben."); return; }
  w.document.write(html);
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 450);
}
