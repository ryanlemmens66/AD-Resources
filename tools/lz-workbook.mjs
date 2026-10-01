/*
  tools/lz-workbook.mjs -- read the Aerodromes & LZs workbook (.xlsx) for tools/data.mjs.

  The workbook is the maintained source of the aerodromes-lzs dataset: one sheet per region,
  named for the region and titled "<Region> Landing Zones", a header row starting "LZ ID", "LZ Name", and one row per
  site. "LZ ID" (LZ-000001 ...) is the site's permanent id; the app keeps it, so a renamed or
  moved site stays the same site. The Control and _Lists sheets are ignored, apart from
  _Lists' StatusList, which is returned so data.mjs can check it against the statuses it knows.

  No dependencies: an .xlsx file is a ZIP of XML parts, read here with node:zlib.
*/
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/* Workbook column -> dataset property. Latitude and Longitude become the point geometry. */
export const LZ_COLUMNS = Object.freeze({
  'LZ ID': 'id', 'LZ Name': 'name', 'Status': 'status', 'Operational Priority': 'operationalPriority',
  'LZ Type': 'siteType', 'District': 'district', 'FENZ Required': 'fenzRequired', 'FENZ Notes': 'fenzNotes',
  'Last Verified': 'lastVerified', 'Expiry Date': 'expiryDate', 'Known Hazards': 'hazards', 'LZ Notes': 'notes',
  'Latitude': 'latitude', 'Longitude': 'longitude',
});
const DATE_COLUMNS = new Set(['lastVerified', 'expiryDate']);

/* ZIP: find each entry through the central directory and inflate it. */
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('not an .xlsx file (no ZIP directory)');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    const method = buffer.readUInt16LE(at + 10), size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28), extraLength = buffer.readUInt16LE(at + 30), commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const unescapeXml = (s) => s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (m, n, dec, hex) =>
  dec ? String.fromCodePoint(+dec) : hex ? String.fromCodePoint(parseInt(hex, 16)) : { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[n.toLowerCase()]);
/* Cell text with Windows line breaks (and Excel's _x000D_ escape for a carriage return) as plain
   newlines, as the dataset stores them; otherwise every multi-line note would read as changed. */
const lines = (text) => text.replace(/_x000D_/g, '').replace(/\r\n?/g, '\n');
const textOf = (xml) => lines([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join(''));
const columnIndex = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

/* Every sheet as rows of cell text, by sheet name. */
function readSheets(path) {
  const files = unzip(readFileSync(path));
  const part = (name) => files.get(name)?.toString('utf8') || '';
  const shared = [...part('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const targets = Object.fromEntries([...part('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)]
    .map((m) => [/Id="([^"]+)"/.exec(m[0])[1], /Target="([^"]+)"/.exec(m[0])[1]]));
  const sheets = new Map();
  for (const m of part('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)) {
    const name = unescapeXml(/name="([^"]*)"/.exec(m[0])[1]);
    const target = targets[/r:id="([^"]+)"/.exec(m[0])[1]].replace(/^\/?(xl\/)?/, 'xl/');
    const rows = [];
    for (const row of part(target).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /r="([A-Z]+\d+)"/.exec(c[1])?.[1];
        const type = /t="([^"]+)"/.exec(c[1])?.[1];
        const value = /<v>([\s\S]*?)<\/v>/.exec(c[2] || '')?.[1];
        cells[columnIndex(ref)] = type === 's' ? shared[+value] : type === 'inlineStr' ? textOf(c[2] || '') : value === undefined ? '' : unescapeXml(value);
      }
      rows.push(Array.from(cells, (v) => v ?? ''));
    }
    sheets.set(name, rows);
  }
  return sheets;
}

/* An Excel date is stored as a day count from 30 December 1899; the dataset uses DD/MM/YYYY.
   Text dates are kept as written (data.mjs warns about any that are not DD/MM/YYYY). */
function toDate(value) {
  if (!/^\d{5}(\.\d+)?$/.test(value)) return value;
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(+value) * 86400000);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}
/* Excel keeps binary floating point (-35.385420000000003); 8 decimal places is about 1 mm. */
const toCoordinate = (value) => (value === '' ? NaN : Number(Number(value).toFixed(8)));

/* Rows as { line, feature } in the shape data.mjs imports, plus the workbook's StatusList. */
export function readLzWorkbook(path) {
  const sheets = readSheets(path);
  const incoming = [], problems = [];
  for (const [sheet, rows] of sheets) {
    // A region sheet is titled with its own name: "Northland" -> "Northland Landing Zones".
    const title = String(rows[0]?.find((v) => v) || '').trim();
    if (title !== `${sheet} Landing Zones`) continue;
    const region = sheet;
    const header = (rows[1] || []).map((h) => String(h).trim());
    for (const column of Object.keys(LZ_COLUMNS))
      if (!header.includes(column)) problems.push(`sheet "${sheet}": missing column "${column}"`);
    for (const extra of header.filter((h) => h && !LZ_COLUMNS[h]))
      problems.push(`sheet "${sheet}": unknown column "${extra}" (the app would not show it)`);
    rows.slice(2).forEach((cells, i) => {
      const get = (column) => String(cells[header.indexOf(column)] ?? '').trim();
      if (!Object.keys(LZ_COLUMNS).some((column) => get(column))) return; // blank row
      const properties = { id: get('LZ ID'), name: get('LZ Name'), region };
      for (const [column, key] of Object.entries(LZ_COLUMNS)) {
        if (key === 'id' || key === 'name' || key === 'latitude' || key === 'longitude') continue;
        properties[key] = DATE_COLUMNS.has(key) ? toDate(get(column)) : get(column);
      }
      incoming.push({ line: `${sheet} row ${i + 3}`, feature: { type: 'Feature', properties,
        geometry: { type: 'Point', coordinates: [toCoordinate(get('Longitude')), toCoordinate(get('Latitude'))] } } });
    });
  }
  if (!incoming.length && !problems.length) problems.push('no "<Region> Landing Zones" sheets found');
  const lists = sheets.get('_Lists') || [];
  const statusColumn = (lists[0] || []).indexOf('StatusList');
  const statusList = statusColumn < 0 ? [] : lists.slice(1).map((r) => String(r[statusColumn] || '').trim()).filter(Boolean);
  return { incoming, problems, statusList };
}
