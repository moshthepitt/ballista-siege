"""Subset UI fonts to ASCII and literal source characters. Requires fonttools[woff]."""
from pathlib import Path
from fontTools import subset
import shutil
import sys

root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 2: raise SystemExit('Usage: python scripts/subset-fonts.py ORIGINAL_FONT_DIRECTORY')
source = Path(sys.argv[1])
output_dir = root / '.tmp/font-subsets'
output_dir.mkdir(parents=True, exist_ok=True)
characters = set(range(32, 127))
for path in (root / 'play').rglob('*'):
    if path.suffix in ('.ts', '.html', '.css') and 'dist' not in path.parts and not path.name.endswith('.test.ts'):
        characters.update(ord(c) for c in path.read_text() if ord(c) > 127)
for name in ('lilita-one-latin.woff2', 'rubik-latin-var.woff2'):
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = [f for f in options.layout_features if f not in ('frac', 'numr', 'dnom')] + ['tnum']
    options.hinting = False
    # ASCII UI copy does not need mark positioning. Pair-position variations dominate Rubik.
    # Retain outlines, weight variation and substitutions; verify layout through smoke.
    if name.startswith('rubik'): options.drop_tables += ['GPOS']
    font = subset.load_font(str(source / name), options)
    sub = subset.Subsetter(options=options)
    sub.populate(unicodes=characters)
    sub.subset(font)
    output = output_dir / name
    subset.save_font(font, str(output), options)
    print(f'{name}: {output.stat().st_size} bytes')

fonts = root / 'play/public/fonts'
def publish(name):
    temporary = output_dir / (name + '.publish')
    shutil.copyfile(output_dir / name, temporary)
    temporary.replace(fonts / name)
publish('lilita-one-latin.woff2')
combined = sum((output_dir / name).stat().st_size for name in ('lilita-one-latin.woff2', 'rubik-latin-var.woff2'))
if combined <= 25_000:
    publish('rubik-latin-var.woff2')
else:
    (fonts / 'rubik-latin-var.woff2').unlink(missing_ok=True)
    print('Combined subsets exceed 25 kB; switch CSS body stack to system-ui and remove Rubik preload.')
