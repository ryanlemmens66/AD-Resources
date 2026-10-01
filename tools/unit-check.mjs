/*
  tools/unit-check.mjs -- focused unit checks. Each block lifts one piece of the
  app (or sw.js) and runs it against mocks, so a behaviour that needs a live
  service, a map or a real outage can still be exercised on every run:
  the offline shell worker, Scene Weather state handling, the Auto map label
  policy, reference-layer visibility, the closer-aircraft advisories and the
  dataset export/import tool. Any failed assertion throws and
  fails the run.
*/
import { readFileSync } from 'node:fs';
import vm, { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { APP_FILE } from './lib.mjs';

/* ---- Offline shell worker (sw.js) with mocked fetch and cache ---- */
{
const source = readFileSync(new URL('../sw.js', import.meta.url),'utf8');
let count=0;
async function scenario(name, options={}, action){
 const handlers={},deleted=[],stored=[];
 const cached={kind:'cached'},live={ok:true,status:200,clone(){return this}};
 const cache={put:async(k,v)=>{if(options.writeFail)throw Error('quota');stored.push(k)},match:async()=>options.noCache?undefined:cached};
 const context={URL,setTimeout,clearTimeout,fetch:async()=>{if(options.offline)throw Error('offline');return options.response||live},caches:{open:async()=>{if(options.openFail)throw Error('storage');return cache},keys:async()=>['airdesk-shell','airdesk-shell-old','other-app'],delete:async k=>deleted.push(k)},self:{location:{origin:'https://desk.test'},addEventListener:(name,fn)=>handlers[name]=fn,clients:{claim:async()=>{}},skipWaiting:async()=>{}}};
 runInNewContext(source,context);
 await action({context,handlers,deleted,stored,cached,live});
 console.log('PASS '+name);count++;
}
const request={url:'https://desk.test/',method:'GET',mode:'navigate'};
await scenario('live response cached',{},async x=>{assert.equal(await x.context.shellNetworkFirst(request),x.live);assert.deepEqual(x.stored,['/__airdesk-shell'])});
await scenario('cache quota failure preserves live response',{writeFail:true},async x=>assert.equal(await x.context.shellNetworkFirst(request),x.live));
await scenario('unavailable cache preserves live response',{openFail:true},async x=>assert.equal(await x.context.shellNetworkFirst(request),x.live));
await scenario('offline returns saved shell',{offline:true},async x=>assert.equal(await x.context.shellNetworkFirst(request),x.cached));
await scenario('host 503 returns saved shell',{response:{ok:false,status:503}},async x=>assert.equal(await x.context.shellNetworkFirst(request),x.cached));
await scenario('404 is not masked',{response:{ok:false,status:404}},async x=>assert.equal((await x.context.shellNetworkFirst(request)).status,404));
await scenario('offline without saved shell fails visibly',{offline:true,noCache:true},async x=>assert.rejects(x.context.shellNetworkFirst(request),/offline/));
await scenario('activation preserves unrelated caches',{},async x=>{let promise;x.handlers.activate({waitUntil:p=>promise=p});await promise;assert.deepEqual(x.deleted,['airdesk-shell-old'])});
await scenario('live APIs, cross-origin requests and writes are not intercepted',{},async x=>{for(const req of [{...request,mode:'cors'},{...request,method:'POST'},{...request,url:'https://other.test/'}])x.handlers.fetch({request:req,respondWith:()=>assert.fail('unexpected interception')})});
console.log(`All ${count} offline-worker checks passed`);
}

/* ---- Scene Weather loading, stale-response, failure and retry states ---- */
{
const html=readFileSync(APP_FILE,'utf8');
const start=html.indexOf('async function showSceneWeather(){');
const end=html.indexOf('\nfunction boot(){',start);
const dom=new JSDOM('<div id="modal" hidden><div id="modal-body"></div></div>',{runScripts:'outside-only'});
const w=dom.window,d=w.document;let count=0;
const check=(name,fn)=>{fn();count++;console.log('PASS '+name)};
try{
 w.eval(`
 const $=id=>document.getElementById(id);
 const CAA_VFR_MINIMA_HTML='<p>Reference retained</p>';
 function windyEmbedHtml(){return ''}
 function civilTwilightEnd(){return null}
 function formatNZTime(){return ''}
 function fieldsFromResponse(){return [['Temperature','12 C']]}
 const requests=[];
 function fetchWeather(){return new Promise((resolve,reject)=>requests.push({resolve,reject}))}
 const AirDesk={primary:{sceneLocation:{getCoordinate:()=>({lat:-36,lng:174})}},ui:{showModal:(title,body)=>{$('modal').hidden=false;$('modal-body').innerHTML=body}}};
 ${html.slice(start,end)}
 window.openWeather=showSceneWeather;window.requests=requests;
 `);
 let pending=w.openWeather();
 check('weather loading state announced',()=>assert.equal(d.getElementById('scene-weather-loading').getAttribute('role'),'status'));
 w.requests.shift().resolve({});await pending;
 check('weather success replaces loading',()=>{assert.match(d.getElementById('modal-body').textContent,/12 C/);assert.equal(d.getElementById('scene-weather-loading'),null)});
 pending=w.openWeather();d.getElementById('modal').hidden=true;w.requests.shift().resolve({});await pending;
 check('late weather success does not reopen closed dialog',()=>assert.equal(d.getElementById('modal').hidden,true));
 pending=w.openWeather();d.getElementById('modal-body').innerHTML='<p>Another dialog</p>';w.requests.shift().reject(new Error('Unavailable'));await pending;
 check('late weather failure cannot replace another dialog',()=>assert.equal(d.getElementById('modal-body').textContent,'Another dialog'));
 pending=w.openWeather();w.requests.shift().reject(new Error('Unavailable'));await pending;
 check('weather failure retains references and offers retry',()=>{assert.ok(d.getElementById('scene-weather-retry'));assert.match(d.getElementById('modal-body').textContent,/Reference retained/)});
 d.getElementById('scene-weather-retry').click();
 check('weather retry starts a fresh request',()=>{assert.equal(w.requests.length,1);assert.ok(d.getElementById('scene-weather-loading'))});
 w.requests.shift().resolve({});await new Promise(r=>setTimeout(r,0));
 check('weather retry recovers successfully',()=>assert.match(d.getElementById('modal-body').textContent,/12 C/));
 console.log(`All ${count} state checks passed (simulated service responses)`);
}finally{w.close()}
}

/* ---- Auto map island-label policy with a mocked layer API ---- */
{
const html=readFileSync(APP_FILE,'utf8');
const start=html.indexOf('    applyAutoPlaceLabelPolicy(){'),end=html.indexOf('    pauseLinzSymbols(on){',start);
const declaration=html.match(/static AUTO_ISLAND_LABELS = [^;]+;/)[0];
const Adapter=vm.runInNewContext(`class MapLibreLinzAdapter {${declaration}\n${html.slice(start,end)}};MapLibreLinzAdapter`);
const adapter=new Adapter();let zoom=4.7,calls=[];
const layers=[{id:'Place-Label-Island-4',type:'symbol'},{id:'Place-Label-Island-10',type:'symbol'},{id:'Place-Label-City',type:'symbol'}];
adapter.map={getZoom:()=>zoom,getStyle:()=>({layers}),getLayer:id=>layers.find(x=>x.id===id),setLayoutProperty:(...args)=>calls.push(args)};
let count=0;const check=(name,fn)=>{fn();count++;console.log('PASS '+name)};
adapter.vectorStyle='topolite';adapter.applyAutoPlaceLabelPolicy();
check('Auto hides known and additional island labels below 7',()=>{assert.equal(calls.length,2);assert.ok(calls.every(x=>x[2]==='none'))});
check('city labels stay untouched',()=>assert.ok(calls.every(x=>x[0]!=='Place-Label-City')));
calls=[];zoom=7;adapter.applyAutoPlaceLabelPolicy();
check('Auto allows island labels at threshold',()=>assert.ok(calls.length===2&&calls.every(x=>x[2]==='visible')));
calls=[];adapter.vectorStyle='topographic';adapter.applyAutoPlaceLabelPolicy();
check('Topo style is not mutated',()=>assert.equal(calls.length,0));
adapter.vectorStyle='topolite';adapter._linzSymbolsPaused=true;adapter.applyAutoPlaceLabelPolicy();
check('paused symbols are not restored by policy',()=>assert.equal(calls.length,0));
const prepared=html.slice(html.indexOf("            if (mode === 'topolite') {"),html.indexOf('            this._warmStyleDependencies(json, styleUrl);'));
const json={layers:[{id:'Place-Label-Island-4',minzoom:4},{id:'Place-Label-Island-8',minzoom:8},{id:'Place-Label-City',minzoom:2}]};
vm.runInNewContext(prepared,{mode:'topolite',json,MapLibreLinzAdapter:Adapter});
check('first-paint policy preserves stricter native zoom thresholds',()=>{assert.equal(json.layers[0].minzoom,7);assert.equal(json.layers[1].minzoom,8);assert.equal(json.layers[2].minzoom,2)});
console.log(`All ${count} map-policy checks passed (mocked layer API, no map rendering)`);
}

/* ---- Reference layers: default-on layers follow the Layers switch; restore completes ---- */
{
const html=readFileSync(APP_FILE,'utf8');
const script=id=>html.match(new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`))[1];
/* A mocked map: adding a source reports "loading" until the next tick, as MapLibre does. */
const layers=new Map(),sources=new Map();let busy=false;
const map={
  isStyleLoaded:()=>!busy,getSource:id=>sources.get(id),getLayer:id=>layers.get(id),
  addSource:(id,def)=>{sources.set(id,def);busy=true;setTimeout(()=>{busy=false},5)},
  addLayer:def=>layers.set(def.id,{...def,visibility:def.layout?.visibility||'visible'}),
  setLayoutProperty:(id,prop,value)=>{if(prop==='visibility')layers.get(id).visibility=value},
  setPaintProperty(){},moveLayer(){},hasImage:()=>true,addImage(){},on(){},off(){},getCanvas:()=>({style:{}})
};
const AirDesk={util:{escNullish:String},map:{manager:{adapter:{map}}},system:{ready:{afterDom(){}}},data:{}};
const context={AirDesk,setTimeout,clearTimeout,requestAnimationFrame:fn=>setTimeout(fn,0),console};
vm.runInNewContext(script('airdesk-map-layer-runtime')+script('airdesk-reference-layers'),context);
const api=AirDesk.map.referenceLayers,point=(id,x)=>({type:'Feature',properties:{id},geometry:{type:'Point',coordinates:[x,-41]}});
const data={type:'FeatureCollection',features:[point('a',174),point('b',175)]};
['layer-one','layer-two','layer-three'].forEach(id=>api.register({id,title:id,data,visible:true}));
api.register({id:'layer-hidden',title:'hidden',data,visible:false});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const shown=id=>layers.get(`airdesk-reference-${id}-points`)?.visibility;
let count=0;const check=(name,fn)=>{fn();count++;console.log('PASS '+name)};
await wait(400);
check('every default-on layer installs, although each new source reports loading',()=>['layer-one','layer-two','layer-three'].forEach(id=>assert.equal(shown(id),'visible')));
check('a hidden layer is not installed until switched on',()=>assert.equal(shown('layer-hidden'),undefined));
api.setVisible('layer-one',false);await wait(400);
check('a default-on layer switched off stays off',()=>{assert.equal(api.get('layer-one').visible,false);assert.equal(shown('layer-one'),'none')});
api.setVisible('layer-hidden',true);await wait(400);
check('switching a layer on installs and shows it',()=>assert.equal(shown('layer-hidden'),'visible'));
api.setVisible('layer-one',true);
check('switching it back on shows it again',()=>assert.equal(shown('layer-one'),'visible'));
console.log(`All ${count} reference-layer checks passed (mocked map, no rendering)`);
}

/* ---- tools/data.mjs: every dataset exports and re-imports with no change ---- */
{
const { execFileSync } = await import('node:child_process');
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const tool = new URL('./data.mjs', import.meta.url).pathname, dir = mkdtempSync(join(tmpdir(), 'airdesk-data-'));
const run = (...args) => execFileSync(process.execPath, [tool, ...args], { encoding: 'utf8' });
let count = 0;
try {
  for (const line of run('list').trim().split('\n')) {
    const [id, , kind, geometry] = line.trim().split(/\s+/);
    if (kind !== 'features') continue;
    const file = join(dir, `${id}.${geometry === 'Point' ? 'csv' : 'geojson'}`);
    run('export', id, file);
    const out = run('import', id, file);
    assert.match(out, /added: 0\n\s+removed: 0\n\s+renamed: 0\n\s+moved more than 100 m: 0\n\s+other fields changed: 0/, `${id} round trip changed data:\n${out}`);
    count++; console.log(`PASS ${id} exports and re-imports unchanged`);
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(`All ${count} dataset round-trip checks passed (tools/data.mjs, dry run)`);
}

/* ---- tools/data.mjs + lz-workbook.mjs: the Aerodromes & LZs workbook imports directly ---- */
{
const { execFileSync } = await import('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { datasetSource } = await import('./lib.mjs');
const tool = new URL('./data.mjs', import.meta.url).pathname, dir = mkdtempSync(join(tmpdir(), 'airdesk-lzbook-'));
const run = (file) => { try { return execFileSync(process.execPath, [tool, 'import', 'aerodromes-lzs', file], { encoding: 'utf8', stdio: 'pipe' }); }
  catch (error) { return String(error.stdout) + String(error.stderr); } };
/* A minimal .xlsx (stored ZIP, inline strings) with the workbook's layout. */
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8'), fname = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(fname.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fname.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, fname, data); centrals.push(central, fname); offset += 30 + fname.length + data.length;
  }
  const dirBuf = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dirBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBuf, end]);
}
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const sheetXml = (rows) => `<worksheet><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) =>
  typeof v === 'number' ? `<c r="${String.fromCharCode(65 + j)}${i + 1}"><v>${v}</v></c>`
    : `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
const HEAD = ['LZ ID', 'LZ Name', 'Status', 'Operational Priority', 'LZ Type', 'District', 'Latitude', 'Longitude', 'FENZ Required', 'FENZ Notes', 'Last Verified', 'Expiry Date', 'Known Hazards', 'LZ Notes'];
const book = (region, rows, statuses = ['Active', 'Temporary', 'Review Required', 'Inactive', 'Expired']) => zip({
  'xl/workbook.xml': `<workbook><sheets><sheet name="Control" r:id="rId1"/><sheet name="${esc(region)}" r:id="rId2"/><sheet name="_Lists" r:id="rId3"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml': sheetXml([['Aerodromes & Landing Zones'], ['Maintain the landing-zone database']]),
  'xl/worksheets/sheet2.xml': sheetXml([[`${region} Landing Zones`], HEAD, ...rows]),
  'xl/worksheets/sheet3.xml': sheetXml([['StatusList'], ...statuses.map((s) => [s])]),
});
/* Two real sites from the current pack: one kept by name, one renamed in place. */
const lzs = JSON.parse(datasetSource(readFileSync(APP_FILE, 'utf8'), 'aerodromes-lzs')).features;
const [kept, renamed] = lzs.filter((f) => f.properties.region === 'Northland').slice(0, 2);
const multiline = lzs.find((f) => f.properties.region === 'Northland' && /\n/.test(f.properties.notes || '') && f !== kept && f !== renamed);
const row = (id, f, name, status, extra = {}) => [id, name, status, f.properties.operationalPriority, f.properties.siteType, f.properties.district,
  f.geometry.coordinates[1] + 0.000000000000003, f.geometry.coordinates[0], f.properties.fenzRequired || 'Not stated', '', extra.verified ?? '', '', '', extra.notes ?? ''];
let count = 0; const check = (n, f) => { f(); count++; console.log('PASS ' + n); };
try {
  const file = join(dir, 'lz.xlsx');
  writeFileSync(file, book('Northland', [
    row('LZ-000001', kept, kept.properties.name, 'Review Required', { verified: 46242, notes: 'Line one\r\nLine two' }),
    row('LZ-000002', renamed, renamed.properties.name + ' (renamed)', renamed.properties.status),
    ['LZ-000900', 'New Test LZ', 'Temporary', 'Standard', 'LZ', 'Northland', -35.5, 174.1, 'Not stated', '', '', '', '', ''],
    row('LZ-000003', multiline, multiline.properties.name, multiline.properties.status, { verified: multiline.properties.lastVerified || '', notes: multiline.properties.notes.replace(/\n/g, '\r\n') }),
  ]));
  const out = run(file);
  check('workbook rows keep their LZ IDs', () => assert.match(out, new RegExp(`${kept.properties.id} -> LZ-000001 `)));
  check('a renamed site in place is a rename, not a removal and an addition', () =>
    assert.match(out, new RegExp(`renamed: 1\\n\\s+LZ-000002: ${renamed.properties.name.replace(/[()]/g, '\\$&')} -> `)));
  check('a new row is added under its workbook id', () => assert.match(out, /added: 1\n\s+LZ-000900 New Test LZ/));
  check('workbook statuses (Temporary, Review Required) are accepted', () => assert.doesNotMatch(out, /problem\(s\)/));
  check('Excel dates are read as DD/MM/YYYY', () => {
    assert.match(out, /LZ-000001 [^\n]*: status, lastVerified, notes/);
    assert.doesNotMatch(out, /is not DD\/MM\/YYYY/);
  });
  check('multi-line notes with Windows line breaks read as unchanged', () =>
    assert.doesNotMatch(out, new RegExp(`LZ-000003 [^\\n]*: `)));
  const odd = join(dir, 'odd.xlsx');
  writeFileSync(odd, book('Northland', [row('LZ-1', kept, kept.properties.name, 'Unknown')], ['Active', 'Retired']));
  const bad = run(odd);
  check('unknown statuses, malformed LZ IDs and a StatusList the import does not know are refused', () => {
    assert.match(bad, /nothing was changed/);
    assert.match(bad, /LZ ID "LZ-1" is not LZ-000000 form/);
    assert.match(bad, /status "Unknown" is not one of/);
    assert.match(bad, /StatusList has "Retired"/);
  });
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(`All ${count} LZ workbook checks passed (tools/data.mjs, dry run)`);
}

/* ---- Closest Known LZ never offers Inactive, Expired or "Do not use" sites ---- */
{
const html = readFileSync(APP_FILE, 'utf8');
const { datasetSource } = await import('./lib.mjs');
const from = html.indexOf('function knownLZ(){'), to = html.indexOf('/* Road distance/time to the closest known LZ');
assert.ok(from > 0 && to > from, 'Closest Known LZ selection code not found');
const features = JSON.parse(datasetSource(html, 'aerodromes-lzs')).features;
let list = features.map((f) => ({ ...f.properties, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }));
const c = { AirDesk: { data: { directLz: { list: () => list } }, util: { haversineKm: (a, b) => Math.hypot(a.lat - b.lat, (a.lng - b.lng) * Math.cos(a.lat * Math.PI / 180)) * 111.2 } } };
runInNewContext(`${html.slice(from, to)}\nthis.nearest=nearestKnownLZs;`, c);
let count = 0; const check = (n, f) => { f(); count++; console.log('PASS ' + n); };
const morgan = list.find((x) => x.name === 'Morgan Park LZ');
check('an Inactive site is not offered even at its own location (Morgan Park)', () => {
  assert.equal(morgan.status, 'Inactive');
  const offered = c.nearest({ lat: morgan.lat, lng: morgan.lng }, 3);
  assert.equal(offered.length, 3);
  assert.ok(!offered.some((x) => x.name === 'Morgan Park LZ'));
});
check('Expired and "Do not use" sites are not offered; the next nearest are', () => {
  const [a, b, d, e] = [...list].sort((x, y) => x.lat - y.lat);
  list = [{ ...a, status: 'Expired' }, { ...b, operationalPriority: 'Do not use' }, { ...d, status: 'Temporary' }, { ...e, status: 'Review Required' }];
  const names = c.nearest({ lat: a.lat, lng: a.lng }, 3).map((x) => x.name);
  assert.deepEqual(names.sort(), [d.name, e.name].sort());
});
console.log(`All ${count} Closest Known LZ checks passed (real LZ pack, mocked map)`);
}

/* ---- Closer-aircraft advisories with mocked positions and DOM ---- */
{
const html=readFileSync(APP_FILE,'utf8');
const between=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
const dom=new JSDOM('<body>'+['primary','iht','sar'].map(x=>`<div class="mini-actions"><button id="${x}-live-aircraft-btn">Live Aircraft</button></div>`).join('')+'</body>');
const points={primary:{lat:0,lng:0},iht:{lat:10,lng:0},sar:{lat:20,lng:0}};
const bases={primary:{lat:4,lng:0},iht:{lat:14,lng:0},sar:{lat:24,lng:0}};
let opened=null;
const c={document:dom.window.document,Date,Number,Set,RULES:{aircraft:{responseFixStaleMs:300000}},feedStatus:'ok',lastFetch:Date.now(),airborne:[{lat:11,lng:0,transmitted:Date.now()}],boundElements:new Set(),openFleetDetail:w=>opened=w,haversineKm:(a,b)=>Math.hypot(a.lat-b.lat,a.lng-b.lng)*111,AirDesk:{primary:{sceneLocation:{getCoordinate:()=>points.primary},nearestResources:{effectiveBase:()=>bases.primary},responseCalculations:{getLiveAircraft:()=>null}},transfer:{workflow:{getOrigin:()=>points.iht,getSelectedBase:()=>bases.iht}},sar:{scene:{getCoordinate:()=>points.sar,getSelectedBase:()=>bases.sar}}}};
c.getAirborne=()=>c.airborne;
runInNewContext(between('function nearerThanBaseText(','function feedHealthText')+between('function refreshPills(){','function openFleetDetail(workflow){'),c);
let count=0;const check=(n,f)=>{f();count++;console.log('PASS '+n)};
for(const w of ['primary','iht','sar'])c.attachStatusLine(w+'-live-aircraft-btn',w);
c.refreshPills();
const pill=w=>c.document.querySelector('#'+w+'-live-aircraft-btn-status button');
check('IHT compares its sending hospital and selected base',()=>assert.ok(pill('iht')));
check('IHT advisory does not leak into Primary or SAR',()=>{assert.equal(pill('primary'),null);assert.equal(pill('sar'),null)});
check('amber IHT action opens IHT fleet',()=>{pill('iht').click();assert.equal(opened,'iht')});
c.airborne=[{lat:21,lng:0,transmitted:Date.now()}];c.refreshPills();
check('SAR uses its own scene and clears IHT advisory',()=>{assert.ok(pill('sar'));assert.equal(pill('iht'),null)});
check('amber SAR action opens SAR fleet',()=>{pill('sar').click();assert.equal(opened,'sar')});
bases.sar={lat:20.5,lng:0};c.refreshPills();
check('nearer selected resource suppresses SAR advisory',()=>assert.equal(pill('sar'),null));
bases.sar={lat:24,lng:0};c.airborne[0].transmitted=Date.now()-300001;c.refreshPills();
check('stale aircraft fix never raises advisory',()=>assert.equal(pill('sar'),null));
c.airborne[0].transmitted=Date.now();c.feedStatus='fail';c.refreshPills();
check('failed feed suppresses advisory',()=>assert.equal(pill('sar'),null));
c.feedStatus='ok';c.lastFetch=Date.now()-300001;c.refreshPills();
check('stale feed suppresses advisory',()=>assert.equal(pill('sar'),null));
c.lastFetch=Date.now();points.sar=null;c.refreshPills();
check('cleared scene removes advisory without fallback to other tab',()=>assert.equal(pill('sar'),null));
check('FENZ preview is a labelled three-row resizable field',()=>{assert.match(html,/<textarea class="preview preview-short" rows="3" id="fenz-lz-preview" aria-label=/);assert.match(html,/\.preview\.preview-short\s*\{\s*height:\s*auto;\s*min-height:\s*0;\s*resize:\s*vertical;?\s*\}/)});
dom.window.close();console.log(`All ${count} aircraft-advisory checks passed (mocked positions and DOM)`);
}
