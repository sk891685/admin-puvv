import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAnalytics, isSupported, type Analytics } from 'firebase/analytics';
import { getDatabase, type Database } from 'firebase/database';

// Web app's Firebase configuration (public client identifiers)
export const firebaseConfig = {
  apiKey: 'AIzaSyBPZSiSepCsQ0wTO-2qIdyXnx80Uw4bCqU',
  authDomain: 'eneargy-249ce.firebaseapp.com',
  databaseURL: 'https://eneargy-249ce-default-rtdb.firebaseio.com',
  projectId: 'eneargy-249ce',
  storageBucket: 'eneargy-249ce.firebasestorage.app',
  messagingSenderId: '924695601410',
  appId: '1:924695601410:web:29b903b1c36b6a2d04221b',
  measurementId: 'G-WFGP81Q6F3',
};

// Initialize primary Firebase app safely without colliding with named apps (e.g. Google Drive OAuth)
export const app: FirebaseApp =
  getApps().find((existing) => existing.name === '[DEFAULT]') ??
  initializeApp(firebaseConfig);

export const database: Database = getDatabase(app);

let analyticsInstance: Analytics | null = null;

export const analyticsPromise: Promise<Analytics | null> =
  typeof window !== 'undefined'
    ? isSupported()
        .then((supported) => {
          if (!supported) return null;
          analyticsInstance = getAnalytics(app);
          return analyticsInstance;
        })
        .catch(() => null)
    : Promise.resolve(null);

export function getFirebaseAnalytics(): Analytics | null {
  return analyticsInstance;
}
