import json
import os
import re
import sqlite3
from functools import lru_cache
from urllib.parse import quote

import requests
from flask import Flask, jsonify, request

app = Flask(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get('ECDICT_DB', os.path.join(BASE_DIR, 'stardict.db'))

# ⚠️ 部署提示：请在此处填入你自己的邮箱（用于 MyMemory 免费接口的额度提升，不填也能跑）
MYMEMORY_EMAIL = os.environ.get('MYMEMORY_EMAIL', 'YOUR_EMAIL@EXAMPLE.COM').strip()

ENABLE_ONLINE_EXAMPLES = os.environ.get('ENABLE_ONLINE_EXAMPLES', '1') != '0'

HTTP = requests.Session()
HTTP.headers.update({
    'User-Agent': 'WordSnap/2.0 (+dictionary lookup)'
})

POS_LABELS = {
    'n': '名词', 'noun': '名词',
    'v': '动词', 'vi': '不及物动词', 'vt': '及物动词', 'verb': '动词',
    'adj': '形容词', 'a': '形容词', 'adjective': '形容词',
    'adv': '副词', 'ad': '副词', 'adverb': '副词',
    'prep': '介词', 'preposition': '介词',
    'pron': '代词', 'pronoun': '代词',
    'conj': '连词', 'conjunction': '连词',
    'num': '数词', 'numeral': '数词',
    'art': '冠词', 'article': '冠词',
    'interj': '感叹词', 'int': '感叹词',
    'aux': '助动词',
    'phr': '短语', 'phrase': '短语',
    'abbr': '缩写',
}


@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    response.headers['Cache-Control'] = 'no-store'
    return response


def clean_word(text):
    text = str(text or '').strip()
    return re.sub(r'\s+', ' ', text)[:120]


def strip_word(text):
    return ''.join(ch for ch in text.lower() if ch.isalnum())


def db_exists():
    return os.path.isfile(DB_PATH) and os.path.getsize(DB_PATH) > 1024


def open_db():
    uri = f'file:{DB_PATH}?mode=ro'
    conn = sqlite3.connect(uri, uri=True, timeout=2.0)
    conn.row_factory = sqlite3.Row
    return conn


def row_to_dict(row):
    if not row:
        return None
    return {k: row[k] for k in row.keys()}


@lru_cache(maxsize=20000)
def query_local(word):
    word = clean_word(word)
    if not word or not db_exists():
        return None

    try:
        conn = open_db()
        try:
            row = conn.execute(
                'SELECT word, phonetic, definition, translation, pos, detail, audio '
                'FROM stardict WHERE word = ? COLLATE NOCASE LIMIT 1',
                (word,)
            ).fetchone()

            if not row:
                sw = strip_word(word)
                if sw:
                    row = conn.execute(
                        'SELECT word, phonetic, definition, translation, pos, detail, audio '
                        'FROM stardict WHERE sw = ? ORDER BY length(word), word COLLATE NOCASE LIMIT 1',
                        (sw,)
                    ).fetchone()
            return row_to_dict(row)
        finally:
            conn.close()
    except Exception as exc:
        print('ECDICT query error:', exc)
        return None


def split_translation_lines(text):
    if not text:
        return []
    out = []
    for line in re.split(r'[\r\n]+', str(text)):
        line = re.sub(r'\s+', ' ', line).strip(' ;；')
        if line:
            out.append(line)
    return out


def normalize_pos(token):
    token = str(token or '').lower().strip().rstrip('.')
    return POS_LABELS.get(token, token or '释义')


def parse_meanings(row):
    if not row:
        return []

    groups = []
    index = {}
    lines = split_translation_lines(row.get('translation'))

    pos_re = re.compile(r'^([a-zA-Z]{1,12}(?:\.[a-zA-Z]{1,12})*)\.\s*(.+)$')
    for line in lines:
        match = pos_re.match(line)
        if match:
            raw_pos = match.group(1).lower()
            body = match.group(2).strip()
            pos = normalize_pos(raw_pos)
        else:
            body = line
            pos = '释义'

        values = [
            x.strip() for x in re.split(r'[；;]+', body)
            if x.strip()
        ]
        if not values:
            continue

        if pos not in index:
            index[pos] = len(groups)
            groups.append({'pos': pos, 'translations': []})
        target = groups[index[pos]]['translations']
        for value in values:
            if value not in target:
                target.append(value)
            if len(target) >= 8:
                break

    if not groups and row.get('translation'):
        groups.append({'pos': '释义', 'translations': [str(row['translation']).strip()]})

    return groups[:8]


def compact_translation(row):
    meanings = parse_meanings(row)
    values = []
    for group in meanings:
        for item in group['translations']:
            item = re.sub(r'^[a-zA-Z]{1,10}\.\s*', '', item).strip()
            if item and item not in values:
                values.append(item)
            if len(values) >= 3:
                return '；'.join(values)
    return '；'.join(values) if values else ''


def parse_detail_json(value):
    if not value:
        return None
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except Exception:
        return None


def recursively_collect_examples(obj, out, depth=0):
    if depth > 5 or len(out) >= 3:
        return
    if isinstance(obj, dict):
        lower = {str(k).lower(): v for k, v in obj.items()}
        sentence = lower.get('sentence') or lower.get('example') or lower.get('sample')
        translation = lower.get('translation') or lower.get('trans') or lower.get('chinese')
        if isinstance(sentence, str) and len(sentence.strip()) > 5:
            pair = {
                'en': re.sub(r'\s+', ' ', sentence).strip(),
                'zh': re.sub(r'\s+', ' ', translation).strip() if isinstance(translation, str) else '',
                'pos': ''
            }
            if not any(x['en'] == pair['en'] for x in out):
                out.append(pair)
        for value in obj.values():
            recursively_collect_examples(value, out, depth + 1)
    elif isinstance(obj, list):
        for value in obj:
            recursively_collect_examples(value, out, depth + 1)


def local_examples(row):
    out = []
    if row:
        recursively_collect_examples(parse_detail_json(row.get('detail')), out)
    return out[:3]


def online_dictionary_examples(word):
    if not ENABLE_ONLINE_EXAMPLES:
        return []
    try:
        url = 'https://api.dictionaryapi.dev/api/v2/entries/en/' + quote(word)
        res = HTTP.get(url, timeout=2.3)
        if res.status_code != 200:
            return []
        data = res.json()
        if not isinstance(data, list):
            return []

        out = []
        for entry in data[:2]:
            for meaning in entry.get('meanings', []) or []:
                pos = normalize_pos(meaning.get('partOfSpeech', ''))
                for definition in meaning.get('definitions', []) or []:
                    example = definition.get('example')
                    if isinstance(example, str) and len(example.strip()) > 5:
                        text = re.sub(r'\s+', ' ', example).strip()
                        if not any(x['en'] == text for x in out):
                            out.append({'en': text, 'zh': '', 'pos': pos})
                    if len(out) >= 3:
                        return out
        return out
    except Exception as exc:
        print('dictionaryapi example error:', exc)
        return []


def mymemory_translate(text):
    params = {
        'q': text,
        'langpair': 'en|zh-CN'
    }
    # ⚠️ 如果你在上面没有配置真实邮箱，这里会自动跳过
    if MYMEMORY_EMAIL and MYMEMORY_EMAIL != 'YOUR_EMAIL@EXAMPLE.COM':
        params['de'] = MYMEMORY_EMAIL
    try:
        res = HTTP.get('https://api.mymemory.translated.net/get', params=params, timeout=2.4)
        if res.status_code != 200:
            return ''
        data = res.json()
        result = data.get('responseData', {}).get('translatedText', '')
        if isinstance(result, str):
            result = result.strip()
            if result and 'QUERY LENGTH LIMIT' not in result.upper():
                return result
    except Exception as exc:
        print('MyMemory error:', exc)
    return ''


def google_fallback(text):
    try:
        url = (
            'https://translate.googleapis.com/translate_a/single'
            '?client=gtx&sl=en&tl=zh-CN&dt=t&q=' + quote(text)
        )
        res = HTTP.get(url, timeout=3.0)
        if res.status_code != 200:
            return ''
        data = res.json()
        if data and data[0]:
            return ''.join(seg[0] for seg in data[0] if seg and seg[0]).strip()
    except Exception as exc:
        print('Google fallback error:', exc)
    return ''


@lru_cache(maxsize=12000)
def translate_online_cached(text):
    text = clean_word(text)
    if not text:
        return ''
    return mymemory_translate(text) or google_fallback(text)


def translate_text(text, allow_online=True):
    text = clean_word(text)
    if not text:
        return ''

    if len(text) <= 80 and re.fullmatch(r"[A-Za-z][A-Za-z'’()\- /]*", text):
        row = query_local(text)
        local = compact_translation(row)
        if local:
            return local

    if allow_online:
        return translate_online_cached(text)
    return ''


def fallback_example(word):
    return {
        'en': f'I wrote down the word "{word}" so I could remember it.',
        'zh': f'我把单词“{word}”记下来，以便记住它。',
        'pos': '记忆例句'
    }


def build_detail(word):
    word = clean_word(word)
    row = query_local(word)
    meanings = parse_meanings(row)
    phonetic = (row or {}).get('phonetic') or ''

    examples = local_examples(row)
    if len(examples) < 2:
        for item in online_dictionary_examples(word):
            if not any(x['en'] == item['en'] for x in examples):
                examples.append(item)
            if len(examples) >= 3:
                break

    for item in examples[:3]:
        if not item.get('zh'):
            item['zh'] = translate_online_cached(item['en'])

    examples = [x for x in examples if x.get('en')]
    if not examples:
        examples = [fallback_example(word)]

    if not meanings:
        fallback = translate_online_cached(word)
        if fallback:
            meanings = [{'pos': '释义', 'translations': [fallback]}]
        else:
            meanings = [{'pos': '释义', 'translations': ['暂未找到释义']}]

    return {
        'word': (row or {}).get('word') or word,
        'phonetic': phonetic,
        'meanings': meanings,
        'examples': examples[:3],
        'source': 'ecdict' if row else 'fallback'
    }


@app.route('/', methods=['POST', 'OPTIONS'])
def api():
    if request.method == 'OPTIONS':
        return ('', 204)

    try:
        data = request.get_json(silent=True) or {}
        action = str(data.get('action') or 'translate').lower()

        if action == 'translate':
            text = clean_word(data.get('text', ''))
            if not text:
                return jsonify({'error': 'Missing text'}), 400
            result = translate_text(text, allow_online=True) or '暂无释义'
            return jsonify({'translation': result})

        if action == 'batch':
            texts = data.get('texts') or []
            if not isinstance(texts, list):
                return jsonify({'error': 'texts must be an array'}), 400
            texts = [clean_word(x) for x in texts[:300]]
            out = {}
            for text in texts:
                if not text:
                    continue
                local = translate_text(text, allow_online=False)
                out[text.lower()] = local or ''
            return jsonify({'translations': out})

        if action == 'detail':
            word = clean_word(data.get('word') or data.get('text') or '')
            if not word:
                return jsonify({'error': 'Missing word'}), 400
            return jsonify(build_detail(word))

        if action == 'health':
            return jsonify({
                'ok': True,
                'ecdict': db_exists(),
                'dbPath': os.path.basename(DB_PATH)
            })

        return jsonify({'error': 'Unknown action'}), 400

    except Exception as exc:
        print('translate api error:', exc)
        return jsonify({
            'error': str(exc),
            'translation': '翻译暂不可用'
        }), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', '9000')))