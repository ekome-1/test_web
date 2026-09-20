# Blur Studio

ドラッグ&ドロップしたPNGにガウスブラーをかけ、PNGとして保存する静的Webアプリです。画像畳み込みコアはWebAssemblyで動き、サーバーへのアップロードは行いません。

## ローカルで試す

ローカルHTTPサーバーを起動します（`file://`で直接開く方法はWASMを読み込めないため使えません）。

```sh
python3 -m http.server 8080
```

ブラウザで <http://localhost:8080/> を開きます。

## 公開する

このフォルダの内容をそのまま静的ホスティングへ配置できます。実行時のビルド工程やバックエンドは不要です。`index.html`を公開ルートにし、`app.js`、`style.css`、`gaussian_blur.wasm`も同じ階層に置いてください。HTTPS対応の静的ホスティングを使って公開してください。GitHub Pages、Netlify、Cloudflare Pagesなどが候補です。

公開サイトをHTTPのまま運用するのは避けてください。HTTPでは通信内容を盗み見られたり、途中でページやJavaScriptを書き換えられたりする可能性があります。このサイトは選択画像をアップロードしませんが、改ざんされたJavaScriptは画像を読み取って外部送信できてしまいます。HTTPSを有効にし、可能ならHTTPからHTTPSへの転送も設定してください。ローカル開発用の`http://localhost`は公開サイトとは別です。GitHub PagesではHTTPSを強制する設定が利用できます。

Google Fontsを取得できない環境でもシステムフォントへフォールバックします。画像処理そのものはオフラインでも動作します。

## 使い方

1. PNGをドロップするか「ファイルを選択」を押します。
2. ぼかしの強さを調整します。
3. 「PNGを保存」を押します。

最大ファイルサイズは20 MB、最大画像サイズは800万画素です。ブラーは横・縦のbox blurを3回重ねてGaussian blurを近似し、透明PNGの縁が黒ずみにくいようpremultiplied alphaで処理します。この近似により処理量はぼかし半径に大きく依存せず、比較的大きな画像でもブラウザを固めにくくしています。

WASMを再ビルドする場合はEmscriptenと`wasm-ld`を用意して実行します。

```sh
./build-wasm.sh
```

## WASMについて

`gaussian_blur.c`をfreestanding WASM moduleとしてビルドし、JavaScriptはRGBAピクセルをlinear memoryへコピーして`blur_rgba`を呼び出します。画像のdecode/encode、UI、ダウンロードだけをブラウザJavaScriptに担当させています。
# test_web
# test_web
