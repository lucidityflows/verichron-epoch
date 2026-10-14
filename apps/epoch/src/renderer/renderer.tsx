import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
import { ToastProvider } from './components/ui/Toast';

const root = createRoot(document.getElementById('root')!);
root.render(
  <ToastProvider>
    <App />
  </ToastProvider>
);
