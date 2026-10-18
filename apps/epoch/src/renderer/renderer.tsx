import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
import { ToastProvider } from './components/ui/Toast';
import { ActivityLogWindow } from './features/activityLog/ActivityLogDock';

// The Activity Log's pop-out window loads this page with #activity-log (EPOCH-570).
const popOut = window.location.hash === '#activity-log';
if (popOut) document.title = 'Activity Log';

const root = createRoot(document.getElementById('root')!);
root.render(<ToastProvider>{popOut ? <ActivityLogWindow /> : <App />}</ToastProvider>);
