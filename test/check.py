import zipfile, sys, re
from xml.dom import minidom
for f in sys.argv[1:]:
    z = zipfile.ZipFile(f); bad = 0
    for n in z.namelist():
        if n.endswith('.xml') or n.endswith('.rels'):
            try: minidom.parseString(z.read(n))
            except Exception as e: bad += 1; print('  BAD', n, e)
    d = z.read('word/document.xml').decode()
    print(f, 'xml-ok' if not bad else 'XML ERRORS', 'oMath:', d.count('<m:oMath>'), 'leftover placeholders:', len(re.findall('@@[MC]', d + z.read('word/footnotes.xml').decode())))
