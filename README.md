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

アプリ上部の切り替えボタンで2つのモードを使えます。

### 🚻 最寄りモード
- **現在地の取得**: 起動時にブラウザの Geolocation API で現在地を取得し、地図の中心に表示
- **トイレ検索**: Overpass API (`amenity=toilets`) で周辺のトイレを検索し、マーカー表示
- **自動範囲拡大**: 半径 500m → 1km → 2km → 4km と、見つかるまで検索範囲を自動的に拡大。最後まで見つからない場合は通知
- **徒歩ルート案内**: マーカーをタップすると OSRM (footプロファイル) による徒歩ルートを地図上に描画し、距離と所要時間の目安(徒歩 80m/分換算)を表示
- **トイレの詳細表示**: 車椅子対応・有料/無料・営業時間・おむつ交換台などのタグ情報を表示

### 🧭 安心ルートモード
目的地までの**最短ルートではなく**、常に車で1分以内にトイレへ行けるようにトイレを経由しながら向かうルートを組み立てます。

- 目的地を住所・駅名・施設名で入力すると、出発地→目的地の進行方向にある帯状の範囲 (コリドー) のトイレを Overpass の矩形検索で取得
- 「まだ1分圏内に置ける最も先のトイレ」を選び続ける貪欲法で経由地を決定し、OSRM (car プロファイル) で実際の道路距離・所要時間を検証
- 検証の結果、1分を超える区間が見つかった場合はその区間だけ狭い範囲で再検索して1回だけ補完を試み、それでも補えない区間は地図上とリストで警告表示 (経由地点のピンもオレンジ色になる)
- 区間ごとの一覧 (次のトイレ/目的地まで何分か)、全体の所要時間・到着時刻、「✅ 全区間1分以内」/「⚠ N区間で1分超過」のサマリーを表示

## エラーハンドリング

- **位置情報が許可されない場合**: 住所・駅名・施設名の入力欄を表示し、Nominatim でジオコーディングして検索の起点にできます
- **Overpass API の遅延・失敗**: ローディング表示を出しつつ、複数のミラーサーバー (overpass-api.de / kumi.systems / private.coffee) へ順にフォールバック。全滅した場合は「再試行」ボタンを表示
- **ルート検索の失敗**: OSRM の複数エンドポイントを試し、すべて失敗した場合は直線ルート(点線表示)と直線距離ベースの概算時間にフォールバック
- **安心ルートのコリドー検索失敗**: トイレ経由なしの直接ルートにフォールバックし、その旨を警告表示
- **近すぎる/遠すぎる目的地**: 安心ルートは100m〜60km向けの機能である旨をわかりやすく通知

## 🍎 iOSネイティブアプリ (Capacitor)

`ios/` ディレクトリに Xcode プロジェクトを同梱しています。WebアプリをそのままWKWebViewで包み、位置情報はネイティブの許可ダイアログ(`NSLocationWhenInUseUsageDescription` 設定済み)経由で取得します。

### ビルド手順 (macOS + Xcode が必要)

```bash
npm install
npm run build          # Webアセットを dist/ に生成
npx cap sync ios       # dist/ を iOSプロジェクトへコピー & プラグイン同期
npx cap open ios       # Xcode でプロジェクトを開く
```

Xcode側では:
1. `App` ターゲットの **Signing & Capabilities** で自分の Apple ID (Team) を選択
2. 実機またはシミュレータを選んで **Run (⌘R)**
3. 実機配布は Archive → TestFlight / App Store Connect へ

- Bundle ID: `com.toiletfinder.app`(App Store公開時は自分のものに変更)
- アプリアイコン(1024px)設定済み / 日本語ローカライズ設定済み
- Capacitor 8 (Swift Package Manager) のため CocoaPods は不要です

Macがない場合も、PWA版(ホーム画面に追加)なら同じ機能をそのまま使えます。

## ⚡ 爆速モード (静的トイレデータタイル)

Overpass API の応答待ち (2〜10秒) を消すため、日本全国のトイレ・コンビニ・GSデータを
事前抽出した静的タイルを同梱できます。タイルがあれば検索は数十msで完了し、
無ければ従来どおり Overpass に自動フォールバックします (単一HTML版はフォールバック動作)。

```bash
node scripts/build-toilet-tiles.mjs   # 約15〜25分。public/toilet-tiles/v1/ に生成
npm run build                          # dist/ にタイルも含まれる
```

- GitHub Actions (`build-toilet-tiles.yml`) が週1回自動で再生成・コミットします
- Netlify等には `dist/` フォルダごとデプロイしてください (タイルを含めるため)

## 技術スタック

- React 18 + Vite
- Capacitor 8 (iOSネイティブ化 + Geolocationプラグイン)
- Leaflet.js (地図描画)
- CARTO Voyager タイル (Googleマップ風の簡素な地図デザイン、データは OpenStreetMap)
- Overpass API (トイレ位置情報、半径検索 + コリドーの矩形検索)
- OSRM (徒歩ルート: routing.openstreetmap.de / 車ルート: router.project-osrm.org)
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
