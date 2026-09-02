import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode><App /></React.StrictMode>
);

// Registers the service worker, which is what lets the app install to a
// phone home screen. Failure here is not fatal: the app still works as a
// normal website.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // localhost counts as a secure context, so this works in development too.
    navigator.serviceWorker.register('/sw.js').catch((e) => {
      console.warn('service worker did not register:', e.message);
    });
  });
}
