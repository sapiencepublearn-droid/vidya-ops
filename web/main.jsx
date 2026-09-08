import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

class AppErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('Sapience Team render error:', error, info); }
  render() {
    if (this.state.error) {
      return React.createElement('div', { style: { fontFamily: 'system-ui', padding: 32, maxWidth: 720, margin: '0 auto' } },
        React.createElement('h2', null, 'Sapience Team could not load this page'),
        React.createElement('p', null, this.state.error?.message || 'Unexpected application error.'),
        React.createElement('button', { onClick: () => window.location.reload(), style: { padding: '10px 16px' } }, 'Reload'));
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode><AppErrorBoundary><App /></AppErrorBoundary></React.StrictMode>
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
