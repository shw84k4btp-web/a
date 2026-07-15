// スタンドアロン単一HTML版のエントリ。
// Service Worker は単一ファイルに埋め込めないため PWA 登録なしで起動する。
import React from 'react';
import ReactDOM from 'react-dom/client';
import 'leaflet/dist/leaflet.css';
import './App.css';
import App from './App.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
