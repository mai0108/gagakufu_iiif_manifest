#!/usr/bin/env node
'use strict';

/**
 * pieces-index.json 再生成スクリプト
 * ----------------------------------------------------------------
 * 目的:
 *   docs/100270332_pieces/ と docs/100376839_pieces/ にある曲マニフェスト
 *   JSON 群（例: "笙_壱越調_調子_1016-1021.json"）を読み込み、各コレクションの
 *   検索インデックス pieces-index.json（曲一覧 + 統計情報）を丸ごと再生成する。
 *
 *   曲JSONを追加・削除・修正した後は、このスクリプトを実行するだけで
 *   pieces-index.json の内容を最新の状態に同期できる。
 *
 * 使い方:
 *   node tools/build-pieces-index.js
 *
 *   リポジトリのルート（このファイルから見て一つ上のディレクトリ）を基準に
 *   docs/<ID>_pieces/ を読み書きするため、どのディレクトリから実行しても良い。
 *
 * 注意:
 *   - 曲JSONに Title / Instrument / "Page Range" のいずれかが欠けている場合や
 *     page_range が「数字-数字」形式でない場合はエラーとして扱い、
 *     該当ファイル名を表示したうえで exit code 1 で終了する
 *     （この場合 pieces-index.json はいずれも書き換えない）。
 *   - ファイル名末尾の `_<start>-<end>.json` と metadata の Page Range が
 *     食い違う場合は警告を stderr に出すが、処理は続行する。
 *   - 一部の曲JSONは、まだ本番公開されていない下書き（@id が
 *     "https://example.com/..." や "https://your-domain.org/..." のような
 *     プレースホルダードメインになっている）が同じディレクトリに残っている
 *     ことがある。これらは現行の pieces-index.json にも含まれていない
 *     下書き・重複ファイルのため、警告を出したうえでインデックスへの
 *     取り込みから除外する。
 *
 *   - [重要] pieces の並び順は、実は2つのコレクションで異なるルールに
 *     なっている（現行ファイルを解析して判明した事実。以下はそれに
 *     script側を合わせた結果であり、両コレクションを1つの単純な
 *     「page_range昇順」だけでは再現できない）。
 *       - 100270332_pieces（宮内庁書陵部所蔵）:
 *         楽器順（笙→篳篥→龍笛）→ 調子順（壱越調→平調→双調→黄鐘調→
 *         太食調→盤渉調の雅楽慣用順）→ page_range開始ページ昇順→
 *         終了ページ昇順→ファイル名順、という優先順位でソートされている。
 *       - 100376839_pieces（東京藝術大学所蔵）:
 *         上記のような楽器/調子の優先順位付けはされておらず、単純に
 *         ファイル名の文字コード順（JSのArray#sortそのもの）になっている。
 *     このため COLLECTIONS の各エントリに sortOrder を持たせ、
 *     コレクションごとに並び替えロジックを切り替えている。
 *     sortOrder を指定しない（null の）場合は後者のファイル名順が既定。
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const IIIF_BASE = 'https://mai0108.github.io/gagakufu_iiif_manifest';

// 対象コレクション定義。将来コレクションを追加する場合はここに追記する。
// sortOrder を指定すると「楽器順→調子順→ページ範囲順→ファイル名順」で
// ソートする。指定しない（省略・null）場合はファイル名の文字コード順になる。
const COLLECTIONS = [
  {
    dirName: '100270332_pieces',
    collection: '宮内庁書陵部所蔵',
    sortOrder: {
      instrumentOrder: ['笙', '篳篥', '龍笛'],
      modeOrder: ['壱越調', '平調', '双調', '黄鐘調', '太食調', '盤渉調'],
    },
  },
  { dirName: '100376839_pieces', collection: '東京藝術大学所蔵', sortOrder: null },
];

// @id がこれらのプレースホルダードメインを含む場合、本番未公開の下書き
// ファイルとみなしてインデックスへの取り込みから除外する。
const PLACEHOLDER_ID_PATTERNS = ['example.com', 'your-domain.org'];

/** JSON.stringify の改行(\n)を、現行ファイルに合わせて CRLF(\r\n) に変換する */
function toCrlfJson(data) {
  return JSON.stringify(data, null, 2).replace(/\n/g, '\r\n');
}

/** ファイル名の文字コード順（JS標準の文字列比較）で比較する */
function compareFilename(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * pieces の並び順を決める比較関数を作る。
 * sortOrder が指定されていれば「楽器順→調子順→ページ開始→ページ終了→
 * ファイル名順」、なければファイル名の文字コード順のみで比較する。
 * 楽器/調子の順序リストに載っていない値は、リスト内の値より後ろに置く。
 */
function makePieceComparator(sortOrder) {
  if (!sortOrder) {
    return (a, b) => compareFilename(a.entry.metadata.filename, b.entry.metadata.filename);
  }
  const { instrumentOrder, modeOrder } = sortOrder;
  const rank = (list, value) => {
    const i = list.indexOf(value);
    return i === -1 ? list.length : i;
  };
  return (a, b) => {
    const ai = rank(instrumentOrder, a.entry.metadata.instrument);
    const bi = rank(instrumentOrder, b.entry.metadata.instrument);
    if (ai !== bi) return ai - bi;
    const am = rank(modeOrder, a.entry.metadata.mode);
    const bm = rank(modeOrder, b.entry.metadata.mode);
    if (am !== bm) return am - bm;
    if (a._sortStart !== b._sortStart) return a._sortStart - b._sortStart;
    if (a._sortEnd !== b._sortEnd) return a._sortEnd - b._sortEnd;
    return compareFilename(a.entry.metadata.filename, b.entry.metadata.filename);
  };
}

function buildCollectionIndex(dirName, collectionName, sortOrder, errors, warnings) {
  const dirPath = path.join(REPO_ROOT, 'docs', dirName);
  const allJsonFiles = fs
    .readdirSync(dirPath)
    .filter((f) => f.endsWith('.json') && f !== 'pieces-index.json')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const pieces = [];

  for (const filename of allJsonFiles) {
    const filePath = path.join(dirPath, filename);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      errors.push(`${dirName}/${filename}: JSONの解析に失敗しました (${e.message})`);
      continue;
    }

    const manifestId = typeof data['@id'] === 'string' ? data['@id'] : '';
    const isPlaceholder = PLACEHOLDER_ID_PATTERNS.some((p) => manifestId.includes(p));
    if (isPlaceholder) {
      warnings.push(
        `${dirName}/${filename}: @id が仮ドメイン (${manifestId}) のため、下書き/重複ファイルとみなしインデックスから除外しました`
      );
      continue;
    }

    const metadataList = Array.isArray(data.metadata) ? data.metadata : [];
    const metaMap = {};
    for (const entry of metadataList) {
      if (entry && typeof entry.label === 'string') {
        metaMap[entry.label] = entry.value;
      }
    }

    const pieceName = metaMap['Title'];
    const instrument = metaMap['Instrument'];
    const pageRange = metaMap['Page Range'];
    const mode = Object.prototype.hasOwnProperty.call(metaMap, 'Cho-shi') ? metaMap['Cho-shi'] : '';

    if (!pieceName || !instrument || !pageRange) {
      const missing = [];
      if (!pieceName) missing.push('Title');
      if (!instrument) missing.push('Instrument');
      if (!pageRange) missing.push('Page Range');
      errors.push(`${dirName}/${filename}: 必須項目が不足しています (${missing.join(', ')})`);
      continue;
    }

    const pageRangeMatch = /^(\d+)-(\d+)$/.exec(pageRange);
    if (!pageRangeMatch) {
      errors.push(`${dirName}/${filename}: Page Range が「数字-数字」形式ではありません (値: "${pageRange}")`);
      continue;
    }
    const rangeStart = Number(pageRangeMatch[1]);
    const rangeEnd = Number(pageRangeMatch[2]);

    // ファイル名末尾の _<start>-<end>.json と metadata の Page Range の整合性チェック（警告のみ）
    const filenameRangeMatch = /_(\d+)-(\d+)\.json$/.exec(filename);
    if (filenameRangeMatch) {
      const fnStart = filenameRangeMatch[1];
      const fnEnd = filenameRangeMatch[2];
      if (fnStart !== pageRangeMatch[1] || fnEnd !== pageRangeMatch[2]) {
        warnings.push(
          `${dirName}/${filename}: ファイル名のページ範囲 (${fnStart}-${fnEnd}) と metadata の Page Range (${pageRange}) が一致しません`
        );
      }
    }

    const label = mode ? `${pieceName} (${instrument} - ${mode})` : `${pieceName} (${instrument})`;

    pieces.push({
      _sortStart: rangeStart,
      _sortEnd: rangeEnd,
      entry: {
        '@id': `${IIIF_BASE}/${dirName}/${filename}`,
        '@type': 'sc:Manifest',
        label,
        metadata: {
          instrument,
          mode,
          piece_name: pieceName,
          page_range: pageRange,
          filename,
          collection: collectionName,
        },
      },
    });
  }

  pieces.sort(makePieceComparator(sortOrder));

  const orderedPieces = pieces.map((p) => p.entry);

  const instrumentsSet = new Set();
  const modesSet = new Set();
  for (const p of orderedPieces) {
    instrumentsSet.add(p.metadata.instrument);
    if (p.metadata.mode) {
      modesSet.add(p.metadata.mode);
    }
  }

  const statistics = {
    total_pieces: orderedPieces.length,
    instruments: Array.from(instrumentsSet).sort(),
    modes: Array.from(modesSet).sort(),
    collections: {
      [collectionName]: orderedPieces.length,
    },
  };

  return { pieces: orderedPieces, statistics };
}

function main() {
  const errors = [];
  const warnings = [];
  const results = [];

  for (const { dirName, collection, sortOrder } of COLLECTIONS) {
    const result = buildCollectionIndex(dirName, collection, sortOrder, errors, warnings);
    results.push({ dirName, collection, result });
  }

  for (const w of warnings) {
    console.error(`警告: ${w}`);
  }

  if (errors.length > 0) {
    console.error('エラー: 以下のファイルに問題があるため、pieces-index.json は更新されませんでした。');
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    process.exit(1);
  }

  for (const { dirName, result } of results) {
    const outPath = path.join(REPO_ROOT, 'docs', dirName, 'pieces-index.json');
    const json = toCrlfJson({ pieces: result.pieces, statistics: result.statistics });
    fs.writeFileSync(outPath, json, 'utf8');
  }

  console.log('pieces-index.json の再生成が完了しました。');
  for (const { dirName, collection, result } of results) {
    console.log(`- ${dirName} (${collection}): ${result.statistics.total_pieces} 曲`);
    console.log(`  楽器: ${result.statistics.instruments.join(', ')}`);
  }
}

main();
