// Générateur PDF minimal (texte, traits, rectangles ; polices Helvetica
// standard, encodage WinAnsi) — sans dépendance externe.
const CP1252 = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, 'œ': 0x9c, 'Œ': 0x8c, 'Ÿ': 0x9f };

function encode(str) {
  const bytes = [];
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    let b;
    if (CP1252[ch]) b = CP1252[ch];
    else if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) b = c;
    else if (ch === '≥') { bytes.push(0x3e, 0x3d); continue; }
    else if (ch === '≤') { bytes.push(0x3c, 0x3d); continue; }
    else if (ch === '↔' || ch === '→') { bytes.push(0x2d, 0x3e); continue; }
    else b = 0x3f;
    if (b === 0x28 || b === 0x29 || b === 0x5c) bytes.push(0x5c);
    bytes.push(b);
  }
  return Buffer.from(bytes).toString('latin1');
}

export class Pdf {
  constructor() {
    this.pages = [];
    this.W = 595;
    this.H = 842;
    this.addPage();
  }
  addPage() {
    this.cur = [];
    this.pages.push(this.cur);
    this.y = this.H - 50;
    return this;
  }
  text(x, y, str, { size = 10, bold = false } = {}) {
    this.cur.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td (${encode(str)}) Tj ET`);
    return this;
  }
  line(x1, y1, x2, y2, w = 0.5) {
    this.cur.push(`${w} w ${x1} ${y1} m ${x2} ${y2} l S`);
    return this;
  }
  rect(x, y, w, h, lw = 0.5) {
    this.cur.push(`${lw} w ${x} ${y} ${w} ${h} re S`);
    return this;
  }
  fit(str, maxWidth, size) {
    const s = String(str ?? '');
    const max = Math.floor(maxWidth / (size * 0.52));
    return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
  }
  // Flux de texte avec saut de page automatique.
  ensure(h) {
    if (this.y - h < 50) this.addPage();
  }
  heading(str, size = 14) {
    this.ensure(size + 14);
    this.y -= 6;
    this.text(50, this.y, str, { size, bold: true });
    this.y -= size + 6;
  }
  para(str, size = 10) {
    this.ensure(size + 4);
    this.text(50, this.y, this.fit(str, this.W - 100, size), { size });
    this.y -= size + 4;
  }
  table(columns, rows, { size = 9 } = {}) {
    // columns : [{ title, width }]
    const rowH = size + 6;
    const drawHead = () => {
      let x = 50;
      for (const c of columns) { this.text(x + 2, this.y, this.fit(c.title, c.width - 4, size), { size, bold: true }); x += c.width; }
      this.line(50, this.y - 3, 50 + columns.reduce((s, c) => s + c.width, 0), this.y - 3);
      this.y -= rowH;
    };
    this.ensure(rowH * 2);
    drawHead();
    for (const r of rows) {
      if (this.y - rowH < 50) { this.addPage(); drawHead(); }
      let x = 50;
      r.forEach((v, i) => { this.text(x + 2, this.y, this.fit(v, columns[i].width - 4, size), { size }); x += columns[i].width; });
      this.y -= rowH;
    }
    this.y -= 6;
  }
  toBuffer() {
    const objs = [];
    const add = (s) => { objs.push(s); return objs.length; };
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const pagesId = objs.length + 1 + this.pages.length * 2;
    const kids = [];
    this.pages.forEach((ops, i) => {
      const footer = `BT /F1 8 Tf 50 25 Td (${encode(`Page ${i + 1} / ${this.pages.length}`)}) Tj ET`;
      const content = [...ops, footer].join('\n');
      const cid = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.W} ${this.H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${cid} 0 R >>`));
    });
    add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
    const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    let out = '%PDF-1.4\n';
    const offsets = [];
    objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(out, 'latin1');
  }
}
