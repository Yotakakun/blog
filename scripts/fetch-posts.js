'use strict'; // 厳格モード。バグを早期発見するために必須

// 必要なモジュール読み込み
const axios = require('axios'); // HTTPリクエスト用
const fs = require('fs'); // ファイル操作用
const path = require('path'); // パス操作用
const slugify = require('slugify'); // タイトルをURL向きに変換
const mkdirp = require('mkdirp'); // フォルダを深い階層ごと作る
const cheerio = require('cheerio'); // HTMLをパースしてjQuery風に操作できる

// APIエンドポイントとAPIキー設定
const API_URL = 'https://your-service.microcms.io/api/v1/blog'; // あなたのmicroCMSのAPIエンドポイントに変更
const API_KEY = process.env.MICROCMS_API_KEY; // セキュリティのため環境変数から取得

// 通信失敗時にリトライするfetch関数
async function fetchWithRetry(url, options, retries = 3) {
  try {
    return await axios.get(url, options); // 通常のGETリクエスト
  } catch (err) {
    if (retries > 0) {
      console.warn(`リクエスト失敗、リトライします... 残り${retries}回`);
      await new Promise(resolve => setTimeout(resolve, 1000)); // 1秒待機してリトライ
      return fetchWithRetry(url, options, retries - 1); // リトライする
    } else {
      throw err; // 失敗しきったらエラーを投げる
    }
  }
}

// 指定したURLの画像をローカル保存する関数
async function downloadImage(url, savePath) {
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream' // ストリーム形式で受信（メモリ節約）
  });

  await mkdirp(path.dirname(savePath)); // 保存先ディレクトリ作成
  const writer = fs.createWriteStream(savePath); // 書き込み用ストリーム
  response.data.pipe(writer); // ダウンロードデータをパイプして保存

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve); // 保存完了時
    writer.on('error', reject); // エラー時
  });
}

// Hexoが呼び出すエクスポート関数
module.exports = async function(hexo) {
  if (!API_KEY) {
    console.error('MICROCMS_API_KEYが設定されていません');
    return; // APIキーがないなら終了
  }

  try {
    // microCMSから記事一覧を取得
    const response = await fetchWithRetry(API_URL, {
      headers: { 'X-API-KEY': API_KEY } // APIキーをヘッダーに付与
    });

    const posts = response.data.contents; // 記事データ本体
    const postsDir = path.join(hexo.source_dir, 'posts'); // 記事保存ディレクトリ
    const assetsDirBase = path.join(hexo.source_dir, 'assets'); // 画像保存ディレクトリ

    if (!fs.existsSync(postsDir)) {
      fs.mkdirSync(postsDir); // postsフォルダがなければ作成
    }

    for (const post of posts) {
      // ファイル名を作成（日付＋タイトルスラッグ）
      const datePart = post.publishedAt.slice(0, 10); // 投稿日を抽出（例: 2025-04-28）
      const slugPart = slugify(post.title, { lower: true, strict: true }); // タイトルをURLスラッグに変換
      const fileName = `${datePart}-${slugPart}.md`; // ファイル名
      const filePath = path.join(postsDir, fileName); // フルパス

      // 本文のHTMLから画像を探してsrcを書き換え
      const $ = cheerio.load(post.body); // cheerioで本文HTMLをロード
      const imgTags = $('img'); // imgタグを全取得

      imgTags.each((_, img) => {
        const src = $(img).attr('src'); // 画像のsrc属性を取得
        if (src) {
          const imageName = path.basename(src.split('?')[0]); // URLから画像名取得（クエリパラメータ除去）
          const localImagePath = path.join('assets', slugPart, imageName); // ローカル保存パス
          $(img).attr('src', `/${localImagePath}`); // srcを書き換え
        }
      });

      const newBody = $.html(); // 画像リンクを書き換えた本文HTML

      // Front Matter生成（tags, categories, description対応）
      const frontMatter = `---
title: "${post.title}"
date: ${post.publishedAt}
tags: ${JSON.stringify(post.tags || [])}
categories: ${JSON.stringify(post.categories || [])}
description: "${post.description || ''}"
---

`;

      const newContent = frontMatter + newBody; // Front Matterと本文を結合

      // 既存ファイルと比較して必要なときだけ保存
      let needWrite = true;
      if (fs.existsSync(filePath)) {
        const existingContent = fs.readFileSync(filePath, 'utf8');
        if (existingContent === newContent) {
          needWrite = false; // 同じなら書き換えない
        }
      }

      if (needWrite) {
        fs.writeFileSync(filePath, newContent); // 新規保存 or 上書き
        console.log(`保存しました: ${fileName}`);
      } else {
        console.log(`変更なし: ${fileName}`);
      }

      // 画像をローカルにダウンロード
      for (const img of imgTags.toArray()) {
        const src = $(img).attr('src'); // 書き換え後のsrc
        if (src && src.startsWith('/assets/')) {
          const assetPath = path.join(hexo.source_dir, src); // 保存先パス
          if (!fs.existsSync(assetPath)) {
            const remoteUrl = src.replace(/^\/assets\/[^/]+\//, post.body.match(/src="(.*?)"/)[1].replace(/\/[^/]+$/, '/'));
            await mkdirp(path.dirname(assetPath)); // ディレクトリを作成
            await downloadImage(remoteUrl, assetPath); // 画像をダウンロード
            console.log(`画像ダウンロード: ${remoteUrl} → ${assetPath}`);
          }
        }
      }
    }

    console.log('microCMSからの記事取得と画像保存が完了しました');
  } catch (err) {
    console.error('記事取得または保存中にエラー:', err.message); // どこでエラーが出たかログする
  }
};