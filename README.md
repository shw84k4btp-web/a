# 🚻 トイレファインダー

現在地から最寄りのトイレを検索し、そこまでの徒歩ルートを案内するWebアプリです。
**PWA対応**しているため、iPhoneのホーム画面に追加すると全画面のネイティブアプリのように使えます。

## 🚀 いちばん簡単な試し方 (コピペでOK)

リポジトリ直下の **`toilet-finder.html`** は、アプリ全体 (JS/CSS込み) を1ファイルにまとめたスタンドアロン版です。

1. PCで [codepen.io/pen](https://codepen.io/pen) を開く
2. `toilet-finder.html` の中身を **全部コピーして HTML パネルに貼り付け**
3. 右上の **Save** → 画面下の **Live View / Full Page View** のURLをiPhoneのSafariで開く
4. 位置情報の許可を求められたら「許可」

または [Netlify Drop](https://app.netlify.com/drop) に `toilet-finder.html` をドラッグ&ドロップすると、数秒でHTTPSのURLが発行されます (`index.html` にリネームしておくとトップで開けます)。

> Geolocation は HTTPS でしか動かないため、ファイルを直接開くのではなく上記のようなHTTPSホスティング経由で開いてください。位置情報が使えない場合でも住所検索で利用できます。

スタンドアロン版の再生成: `npm run build:single`

## 📱 iPhoneにインストールする

1. このアプリをHTTPSでホスティングした上で、**Safari** でURLを開く
2. 画面下の **共有ボタン(□に↑)** をタップ
3. **「ホーム画面に追加」** を選択
4. ホーム画面に 🚻 アイコンが追加され、タップするとスタンドアロン(全画面)で起動します

> 位置情報の利用許可を求められたら「許可」を選んでください。

### iPhone向けの最適化内容

- Web App Manifest + Service Worker(アプリシェルのオフラインキャッシュ、地図タイルのキャッシュ)
- ノッチ / Dynamic Island / ホームバーのセーフエリア対応 (`viewport-fit=cover` + `env(safe-area-inset-*)`)
- iOS Safari のアドレスバーによる `100vh` ずれ対策 (`100dvh`)
- 入力フォームのフォーカス時自動ズーム防止(フォント16px)
- タップハイライト・ダブルタップズーム・オーバースクロールの無効化
- ホーム画面用アイコン (apple-touch-icon / maskable icon)

## 機能

- **現在地の取得**: 起動時にブラウザの Geolocation API で現在地を取得し、地図の中心に表示
- **トイレ検索**: Overpass API (`amenity=toilets`) で周辺のトイレを検索し、マーカー表示
- **自動範囲拡大**: 半径 500m → 1km → 2km → 4km と、見つかるまで検索範囲を自動的に拡大。最後まで見つからない場合は通知
- **徒歩ルート案内**: マーカーをタップすると OSRM (footプロファイル) による徒歩ルートを地図上に描画し、距離と所要時間の目安(徒歩 80m/分換算)を表示
- **トイレの詳細表示**: 車椅子対応・有料/無料・営業時間・おむつ交換台などのタグ情報を表示

## エラーハンドリング

- **位置情報が許可されない場合**: 住所・駅名・施設名の入力欄を表示し、Nominatim でジオコーディングして検索の起点にできます
- **Overpass API の遅延・失敗**: ローディング表示を出しつつ、複数のミラーサーバー (overpass-api.de / kumi.systems / private.coffee) へ順にフォールバック。全滅した場合は「再試行」ボタンを表示
- **ルート検索の失敗**: OSRM の複数エンドポイントを試し、すべて失敗した場合は直線ルート(点線表示)と直線距離ベースの概算時間にフォールバック

## 技術スタック

- React 18 + Vite
- Leaflet.js (地図描画)
- OpenStreetMap (地図タイル)
- Overpass API (トイレ位置情報)
- OSRM / routing.openstreetmap.de (徒歩ルート)
- Nominatim (住所ジオコーディング)

## 開発

```bash
npm install
npm run dev      # 開発サーバー起動
npm run build    # 本番ビルド (dist/)
```

> **Note**: Geolocation API は HTTPS または localhost でのみ動作します。

## データについて

トイレの位置情報は OpenStreetMap のコミュニティデータに基づくため、実際と異なる場合があります。
