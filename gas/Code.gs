/**
 * 夫婦家計簿 — Google Apps Script バックエンド
 * -----------------------------------------------------------------
 * このファイルを、家計簿データを保存したい Google スプレッドシートに
 * 紐づく Apps Script プロジェクトに貼り付けて、ウェブアプリとして
 * 公開してください（手順はこのファイルの一番下を参照）。
 *
 * データの持ち方:
 *   - 「Entries」シート … 家計簿の入力（日々の収支）を1行1件で保存。
 *   - 「Settings」シート … 費目・固定費・予算・ライフプランなど、
 *     それ以外の設定類を key / value(JSON文字列) / updatedAt の
 *     3列で保存する簡易キーバリューストア。
 * どちらのシートも存在しなければ初回アクセス時に自動作成されます。
 */

var ENTRY_HEADERS = ['id', 'date', 'person', 'type', 'category', 'amount', 'memo', 'fixedId', 'createdAt'];
var SETTINGS_HEADERS = ['key', 'value', 'updatedAt'];

// アプリとこのGASを結ぶ「合言葉」。ここにはダミーの値だけを置いています。
// 実際に使う本物の合言葉は、Apps Scriptのこの編集画面（Googleアカウントで
// ログインした人しか見えない場所）で直接書き換えてください。
// このファイル（GitHub上で公開しているコピー）には、本物の値をコミットしないこと。
var SECRET_KEY = 'REPLACE_WITH_YOUR_OWN_SECRET';

function checkSecret_(key) {
  return key === SECRET_KEY;
}

function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!checkSecret_(e.parameter.secret)) {
    return jsonOutput_({ status: 'error', error: 'unauthorized' });
  }
  var payload = {
    status: 'ok',
    entries: readEntries_(ss),
    state: readState_(ss),
  };
  return jsonOutput_(payload);
}

function doPost(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var body = {};
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOutput_({ status: 'error', error: 'invalid JSON body' });
  }

  if (!checkSecret_(body.secret)) {
    return jsonOutput_({ status: 'error', error: 'unauthorized' });
  }

  var action = body.action;
  var payload = body.payload || {};

  switch (action) {
    case 'addEntry':
      addEntry_(ss, payload);
      break;
    case 'updateEntry':
      updateEntry_(ss, payload);
      break;
    case 'deleteEntry':
      deleteEntry_(ss, payload.id);
      break;
    case 'setState':
      setState_(ss, payload.key, payload.value);
      break;
    default:
      return jsonOutput_({ status: 'error', error: 'unknown action: ' + action });
  }

  return jsonOutput_({ status: 'ok' });
}

/* ---------- 家計簿エントリ（Entries シート） ---------- */

function getEntriesSheet_(ss) {
  var sh = ss.getSheetByName('Entries');
  if (!sh) {
    sh = ss.insertSheet('Entries');
    sh.appendRow(ENTRY_HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readEntries_(ss) {
  var sh = getEntriesSheet_(ss);
  var values = sh.getDataRange().getValues();
  var headers = values.shift();
  var tz = Session.getScriptTimeZone();
  return values
    .filter(function (row) { return row[0]; }) // idが空の行は無視
    .map(function (row) {
      var obj = {};
      headers.forEach(function (h, i) { obj[h] = row[i]; });
      if (Object.prototype.toString.call(obj.date) === '[object Date]') {
        obj.date = Utilities.formatDate(obj.date, tz, 'yyyy-MM-dd');
      } else if (obj.date) {
        obj.date = String(obj.date).slice(0, 10);
      }
      obj.amount = Number(obj.amount) || 0;
      return obj;
    });
}

function entryRowValues_(entry) {
  return [
    entry.id || '',
    entry.date || '',
    entry.person || '',
    entry.type || '',
    entry.category || '',
    Number(entry.amount) || 0,
    entry.memo || '',
    entry.fixedId || '',
    entry.createdAt || new Date().toISOString(),
  ];
}

function addEntry_(ss, entry) {
  var sh = getEntriesSheet_(ss);
  sh.appendRow(entryRowValues_(entry));
}

function findEntryRow_(sh, id) {
  var ids = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 0), 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return i + 2; // 1行目はヘッダーなので+2
  }
  return -1;
}

function updateEntry_(ss, entry) {
  var sh = getEntriesSheet_(ss);
  var row = findEntryRow_(sh, entry.id);
  if (row === -1) {
    addEntry_(ss, entry); // 見つからなければ新規追加として扱う
    return;
  }
  sh.getRange(row, 1, 1, ENTRY_HEADERS.length).setValues([entryRowValues_(entry)]);
}

function deleteEntry_(ss, id) {
  var sh = getEntriesSheet_(ss);
  var row = findEntryRow_(sh, id);
  if (row !== -1) sh.deleteRow(row);
}

/* ---------- 設定類（Settings シート・キーバリュー） ---------- */

function getSettingsSheet_(ss) {
  var sh = ss.getSheetByName('Settings');
  if (!sh) {
    sh = ss.insertSheet('Settings');
    sh.appendRow(SETTINGS_HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readState_(ss) {
  var sh = getSettingsSheet_(ss);
  var values = sh.getDataRange().getValues();
  values.shift();
  var state = {};
  values.forEach(function (row) {
    if (row[0]) state[row[0]] = row[1];
  });
  return state;
}

function setState_(ss, key, value) {
  var sh = getSettingsSheet_(ss);
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] === key) {
      sh.getRange(i + 1, 2, 1, 2).setValues([[value, new Date().toISOString()]]);
      return;
    }
  }
  sh.appendRow([key, value, new Date().toISOString()]);
}

/* ---------- 共通 ---------- */

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * ===================== 公開手順 =====================
 * 1. 家計簿データを置きたい Google スプレッドシートを新規作成（空でOK）。
 * 2. メニューの「拡張機能」→「Apps Script」を開く。
 * 3. デフォルトで開かれる Code.gs の中身を全部消して、このファイルの
 *    内容を丸ごと貼り付ける。
 * 3.5. 貼り付けたコードの中の SECRET_KEY を、自分だけの合言葉（長くて
 *    ランダムな文字列）に書き換える。※このファイルをGitHubに置く場合は
 *    ダミーの値のままコミットし、本物の値は貼り付け先の編集画面だけに残す。
 * 4. 画面右上の「デプロイ」→「新しいデプロイ」をクリック。
 * 5. 歯車アイコンから種類を「ウェブアプリ」に設定。
 *      - 実行するユーザー: 自分
 *      - アクセスできるユーザー: 全員
 *    にして「デプロイ」。初回は権限の承認を求められるので許可する。
 * 6. 発行された「ウェブアプリの URL」（.../exec で終わるもの）をコピー。
 * 7. 家計簿アプリ側の右上「設定」→「Google Apps Script 連携」欄に、
 *    その URL と、3.5で決めた合言葉を貼り付けて保存すれば連携完了。
 *
 * ※ コードを後から修正した場合は、「デプロイ」→「デプロイを管理」→
 *    鉛筆アイコンで「新しいバージョン」を選んで再デプロイしないと
 *    変更が反映されません（URLは同じままでOK）。
 * =====================================================
 */
