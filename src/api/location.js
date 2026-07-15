// 現在地取得。ネイティブ (Capacitor iOS) では Geolocation プラグイン、
// Web では従来どおりブラウザの Geolocation API を使う。
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';

const OPTIONS = { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 };

/**
 * 現在地を取得する。
 * @returns {Promise<{lat: number, lng: number}>} 取得できない場合は reject
 */
export async function getCurrentPosition() {
  if (Capacitor.isNativePlatform()) {
    // iOS: Info.plist の NSLocationWhenInUseUsageDescription を使って
    // ネイティブの許可ダイアログを表示する
    const perm = await Geolocation.requestPermissions().catch(() => null);
    if (perm && perm.location === 'denied') {
      throw new Error('permission denied');
    }
    const pos = await Geolocation.getCurrentPosition(OPTIONS);
    return { lat: pos.coords.latitude, lng: pos.coords.longitude };
  }

  if (!navigator.geolocation) {
    throw new Error('geolocation unavailable');
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      reject,
      OPTIONS
    );
  });
}
