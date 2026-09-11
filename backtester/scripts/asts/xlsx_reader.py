"""Stdlib-only xlsx reader: cached values + formulas. No third-party downloads."""
import zipfile, re, xml.etree.ElementTree as ET
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
def load(path):
    z = zipfile.ZipFile(path)
    ss = []
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', NS):
            ss.append(''.join(t.text or '' for t in si.iter('{%s}t' % NS['m'])))
    wb = ET.fromstring(z.read('xl/workbook.xml'))
    rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    rmap = {r.get('Id'): r.get('Target') for r in rels}
    sheets = {}
    for s in wb.find('m:sheets', NS):
        rid = s.get('{%s}id' % NS['r'])
        tgt = rmap[rid].lstrip('/'); tgt = tgt if tgt.startswith('xl/') else 'xl/' + tgt
        cells = {}
        for c in ET.fromstring(z.read(tgt)).iter('{%s}c' % NS['m']):
            ref, t = c.get('r'), c.get('t')
            v = c.find('m:v', NS); f = c.find('m:f', NS)
            val = None
            if v is not None:
                val = v.text
                if t == 's': val = ss[int(val)]
                elif t == 'b': val = val == '1'
                elif t in ('str', 'e', 'inlineStr'): pass
                else:
                    try: val = float(val)
                    except: pass
            elif t == 'inlineStr':
                val = ''.join(x.text or '' for x in c.iter('{%s}t' % NS['m']))
            cells[ref] = (val, f.text if f is not None else None)
        sheets[s.get('name')] = cells
    return sheets
