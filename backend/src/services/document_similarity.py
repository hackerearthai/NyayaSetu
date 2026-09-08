import json
import os
import sys
import re
import zipfile
from difflib import SequenceMatcher

try:
    from PIL import Image
except Exception:
    Image = None

try:
    import fitz
except Exception:
    fitz = None

IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'}
TEXT_EXTS = {'.txt'}
DOCX_EXTS = {'.docx'}
PDF_EXTS = {'.pdf'}


def norm_text(text):
    return re.sub(r'\s+', ' ', text or '').strip().lower()


def text_from_docx(path):
    try:
        with zipfile.ZipFile(path) as z:
            xml = z.read('word/document.xml').decode('utf-8', errors='ignore')
        xml = re.sub(r'</w:p>', '\n', xml)
        xml = re.sub(r'<[^>]+>', ' ', xml)
        return norm_text(xml)
    except Exception:
        return ''


def text_from_file(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in TEXT_EXTS:
        try:
            with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                return norm_text(f.read())
        except Exception:
            return ''
    if ext in DOCX_EXTS:
        return text_from_docx(path)
    return ''


def dhash(img):
    img = img.convert('L').resize((33, 32))
    bits = []
    for y in range(32):
        for x in range(32):
            bits.append(img.getpixel((x, y)) > img.getpixel((x + 1, y)))
    return bits


def ahash(img):
    img = img.convert('L').resize((32, 32))
    pixels = list(img.getdata())
    avg = sum(pixels) / len(pixels)
    return [p >= avg for p in pixels]


def bit_similarity(a, b):
    if not a or not b or len(a) != len(b):
        return 0.0
    return 1.0 - (sum(x != y for x, y in zip(a, b)) / len(a))


def image_fingerprint(path):
    if Image is None:
        return None
    ext = os.path.splitext(path)[1].lower()
    if ext not in IMAGE_EXTS:
        return None
    try:
        with Image.open(path) as im:
            im.load()
            d = dhash(im)
            a = ahash(im)
            return {
                'kind': 'image',
                'width': im.width,
                'height': im.height,
                'dhash': d,
                'ahash': a,
            }
    except Exception:
        return None


def pdf_fingerprints(path, limit=3):
    if Image is None or fitz is None:
        return []
    try:
        doc = fitz.open(path)
        out = []
        for index in range(min(len(doc), limit)):
            page = doc.load_page(index)
            pix = page.get_pixmap(matrix=fitz.Matrix(0.75, 0.75), alpha=False)
            img = Image.frombytes('RGB', [pix.width, pix.height], pix.samples)
            out.append((dhash(img), ahash(img), img.width, img.height))
        doc.close()
        return out
    except Exception:
        return []


def compare(candidate, existing):
    cext = os.path.splitext(candidate)[1].lower()
    eext = os.path.splitext(existing)[1].lower()

    # Visual comparison for images. This catches metadata-only changes and
    # small visual edits even though SHA-256 changes completely.
    if cext in IMAGE_EXTS and eext in IMAGE_EXTS:
        c = image_fingerprint(candidate)
        e = image_fingerprint(existing)
        if c and e:
            dh = bit_similarity(c['dhash'], e['dhash'])
            ah = bit_similarity(c['ahash'], e['ahash'])
            visual = (dh + ah) / 2.0
            same_dimensions = c['width'] == e['width'] and c['height'] == e['height']
            score = visual + (0.01 if same_dimensions else 0.0)
            return min(score, 1.0), 'visual_similarity', {
                'visualSimilarity': round(visual, 4),
                'sameDimensions': same_dimensions,
            }

    if cext in PDF_EXTS and eext in PDF_EXTS:
        c_pages = pdf_fingerprints(candidate)
        e_pages = pdf_fingerprints(existing)
        if c_pages and e_pages:
            count = min(len(c_pages), len(e_pages))
            page_scores = []
            for i in range(count):
                cd, ca, cw, ch = c_pages[i]
                ed, ea, ew, eh = e_pages[i]
                page_scores.append((bit_similarity(cd, ed) + bit_similarity(ca, ea)) / 2.0)
            visual = sum(page_scores) / len(page_scores)
            score = visual + (0.01 if len(c_pages) == len(e_pages) else 0.0)
            return min(score, 1.0), 'visual_similarity', {
                'visualSimilarity': round(visual, 4),
                'pagesCompared': count,
                'samePageCount': len(c_pages) == len(e_pages),
            }

    # Text/DOCX comparison for text-based evidence.
    if cext in TEXT_EXTS | DOCX_EXTS and eext in TEXT_EXTS | DOCX_EXTS:
        c = text_from_file(candidate)
        e = text_from_file(existing)
        if c and e:
            score = SequenceMatcher(None, c, e).ratio()
            return score, 'text_similarity', {'textSimilarity': round(score, 4)}

    # Unsupported formats are intentionally not guessed as similar.
    return 0.0, 'unsupported', {}


def main():
    if len(sys.argv) < 3:
        print(json.dumps({'ok': False, 'error': 'Usage: script candidate existing...'}))
        return 2

    candidate = sys.argv[1]
    existing = sys.argv[2:]
    results = []

    for path in existing:
        if not os.path.isfile(path):
            continue
        score, match_type, details = compare(candidate, path)
        results.append({
            'path': path,
            'score': round(float(score), 4),
            'matchType': match_type,
            **details,
        })

    results.sort(key=lambda x: x['score'], reverse=True)
    print(json.dumps({'ok': True, 'results': results}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
